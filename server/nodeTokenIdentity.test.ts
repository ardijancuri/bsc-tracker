import{describe,it,expect}from'vitest';
import{AbiCoder,encodeBytes32String}from'ethers';
import{decodeNodeTokenIdentityText}from'./nodeProjectionMetadata.js';
const abi=AbiCoder.defaultAbiCoder(),text=(value:string)=>abi.encode(['string'],[value]);
describe('bounded node token contract identity',()=>{
  it('supports standard UTF8 strings and legacy bytes32 without substituting addresses',()=>{
    expect(decodeNodeTokenIdentityText(text('  小企鹅 🚀  '))).toBe('小企鹅 🚀');
    expect(decodeNodeTokenIdentityText(encodeBytes32String('BNB Token'))).toBe('BNB Token');
    expect(decodeNodeTokenIdentityText(text('Line\nName'))).toBe('Line Name');
    expect(decodeNodeTokenIdentityText('0x')).toBeNull();
  });
  it('rejects malformed offsets, excessive lengths, invalid UTF8 and embedded controls',()=>{
    const malformed=`0x${'1'.padEnd(64,'0')}${text('Name').slice(66)}`;
    expect(decodeNodeTokenIdentityText(malformed)).toBeNull();
    expect(decodeNodeTokenIdentityText(text('x'.repeat(129)),128)).toBeNull();
    expect(decodeNodeTokenIdentityText(`0x${'ff'.repeat(32)}`)).toBeNull();
    expect(decodeNodeTokenIdentityText(text('A\u0000B'))).toBeNull();
    expect(decodeNodeTokenIdentityText(`0x410042${'00'.repeat(29)}`)).toBeNull();
    expect(decodeNodeTokenIdentityText(text(''))).toBeNull();
  });
});
