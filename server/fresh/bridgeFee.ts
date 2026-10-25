import {Interface,zeroPadValue,solidityPackedKeccak256} from 'ethers';
import type {FreshCapturedReceipt} from './capture.js';
const endpoint='0x1a44076050125825900e736c501f859c50fe728c';
const sendLib='0x9f8c645f2d0b2159767bd6e0839de4be49e823de';
const abi=new Interface([
 'function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) param,(uint256 nativeFee,uint256 lzTokenFee) fee,address refundAddress) payable',
 'event OFTSent(bytes32 indexed guid,uint32 dstEid,address indexed fromAddress,uint256 amountSentLD,uint256 amountReceivedLD)',
 'event ExecutorFeePaid(address executor,uint256 fee)','event DVNFeePaid(address[] requiredDVNs,address[] optionalDVNs,uint256[] fees)',
 'event PacketSent(bytes encodedPayload,bytes options,address sendLibrary)']);
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Caller authenticates the exact Stockwave OFT creation first. For this narrow
 * native-only send, emitted worker fees exhaust the signed msg.value. The
 * successful endpoint call therefore cannot have an unobserved refund or an
 * extra treasury charge. Other fee modes remain unknown, never zero-filled.
 * https://github.com/LayerZero-Labs/LayerZero-v2/tree/main/packages/layerzero-v2/evm/messagelib/contracts
 */
export function freshStockwaveBridgeFee(entry:FreshCapturedReceipt,token:string):bigint|null{
 try{
  const tx=entry.transaction,receipt=entry.receipt,selector=abi.getFunction('send')!.selector;
  if(tx.to?.toLowerCase()!==token||typeof tx.input!=='string'||!tx.input.toLowerCase().startsWith(selector))return 0n;
  if(receipt.status!=='0x1'||tx.input.length>128*1024||receipt.logs.length>8192)return null;
  const parsed=abi.parseTransaction({data:tx.input});if(!parsed||abi.encodeFunctionData('send',parsed.args).toLowerCase()!==tx.input.toLowerCase())return null;
  const {param,fee,refundAddress}=parsed.args;
  if(BigInt(fee.lzTokenFee)!==0n||BigInt(fee.nativeFee)<=0n||BigInt(fee.nativeFee)!==BigInt(tx.value)||String(refundAddress).toLowerCase()!==tx.from.toLowerCase()
    ||param.composeMsg!=='0x'||param.oftCmd!=='0x')return null;
  const events=(name:string,contract:string)=>receipt.logs.filter(l=>l.address.toLowerCase()===contract&&l.topics[0]===abi.getEvent(name)!.topicHash).map(l=>{
   const p=abi.parseLog(l);if(!p||l.removed)throw Error('bridge_fee_log_invalid');const e=abi.encodeEventLog(p.fragment,p.args);if(e.data.toLowerCase()!==l.data.toLowerCase()||JSON.stringify(e.topics.map(x=>x.toLowerCase()))!==JSON.stringify(l.topics.map(x=>x.toLowerCase())))throw Error('bridge_fee_log_invalid');return p.args;
  });
  const sent=events('OFTSent',token),executors=events('ExecutorFeePaid',sendLib),dvns=events('DVNFeePaid',sendLib),packets=events('PacketSent',endpoint);
  if(sent.length!==1||executors.length!==1||dvns.length!==1||packets.length!==1)return null;
  const s=sent[0],p=packets[0],d=dvns[0];
  if(String(s.fromAddress).toLowerCase()!==tx.from.toLowerCase()||BigInt(s.dstEid)!==BigInt(param.dstEid)||BigInt(s.amountSentLD)<=0n
   ||String(p.sendLibrary).toLowerCase()!==sendLib||d.fees.length!==d.requiredDVNs.length+d.optionalDVNs.length||d.fees.length>64)return null;
  const burns=receipt.logs.filter(l=>l.address.toLowerCase()===token&&l.topics[0]===transfer&&l.topics.length===3
   &&l.topics[1].toLowerCase()===zeroPadValue(tx.from,32).toLowerCase()&&l.topics[2]==='0x'+'0'.repeat(64));
  if(burns.length!==1||burns[0].removed||!/^0x[\da-f]{64}$/i.test(burns[0].data)||BigInt(burns[0].data)!==BigInt(s.amountSentLD))return null;
  const conversionRate=10n**12n,requested=BigInt(param.amountLD),received=BigInt(s.amountReceivedLD);
  if(BigInt(s.amountSentLD)!==received||received!==requested-requested%conversionRate||received<BigInt(param.minAmountLD))return null;
  const packet=Buffer.from(String(p.encodedPayload).slice(2),'hex');
  if(packet.length!==153||packet[0]!==1||packet.readUInt32BE(9)!==30102||packet.readUInt32BE(45)!==Number(param.dstEid)
   ||'0x'+packet.subarray(13,45).toString('hex')!==zeroPadValue(token,32).toLowerCase()||'0x'+packet.subarray(81,113).toString('hex')!==String(s.guid).toLowerCase())return null;
  const guid=solidityPackedKeccak256(['uint64','uint32','bytes32','uint32','bytes32'],[packet.readBigUInt64BE(1),30102,zeroPadValue(token,32),Number(param.dstEid),'0x'+packet.subarray(49,81).toString('hex')]);
  if(guid!==String(s.guid).toLowerCase()||'0x'+packet.subarray(113,145).toString('hex')!==String(param.to).toLowerCase()||packet.readBigUInt64BE(145)!==received/conversionRate)return null;
  const paid=[BigInt(executors[0].fee),...[...d.fees].map((x:unknown)=>BigInt(x as string))];
  if(paid.some(x=>x<0n))return null;const total=paid.reduce((a,b)=>a+b,0n);
  return total===BigInt(tx.value)?total:null;
 }catch{return null;}
}
