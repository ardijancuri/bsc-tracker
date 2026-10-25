import{keccak256}from'ethers';
export function executeSyntheticAudit(initcode:string,options:{address:string;caller:string;timestamp?:bigint;calldata?:string;storage?:Map<bigint,bigint>;balance?:bigint}) {
  const code=Buffer.from(initcode.slice(2),'hex'),calldata=Buffer.from((options.calldata??'0x').slice(2),'hex'),memory=Buffer.alloc(262144),stack:bigint[]=[],storage=new Map(options.storage??[]),calls:any[]=[],logs:any[]=[],visited:number[]=[];
  const copies: {pc: number; source: number; offset: number; length: number; step:number}[] = [], stores: {pc: number; offset: number; value: bigint; step:number}[] = [];
  const writes: string[] = [], validJumps = new Set<number>(), mask = (1n << 256n) - 1n;
  for (let offset = 0; offset < code.length; offset++) { const op = code[offset]; if (op === 0x5b) validJumps.add(offset); if (op >= 0x60 && op <= 0x7f) offset += op - 0x5f; }
  const pop = () => { if (!stack.length) throw new Error('constructor_stack'); return stack.pop()!; };
  const push = (value: bigint) => { if (stack.length >= 1024) throw new Error('constructor_stack'); stack.push(value & mask); };
  const number = (value: bigint) => { if (value > BigInt(memory.length)) throw new Error('constructor_memory'); return Number(value); };
  const bounds = (offset: number, length: number) => { if (offset + length > memory.length) throw new Error('constructor_memory'); };
  const signed = (value: bigint) => value >= (1n << 255n) ? value - (1n << 256n) : value;
  const word = (value: Buffer) => BigInt(`0x${value.toString('hex') || '0'}`);
  const jump = (destination: bigint) => { const value = number(destination); if (!validJumps.has(value)) throw new Error('constructor_jump'); return value; };
  let pc = 0;
  for (let steps = 1; steps <= 1000000; steps++) {
    visited.push(pc); const op = code[pc++]; let a: bigint, b: bigint, offset: number, length: number;
    if (op >= 0x60 && op <= 0x7f) { const count = op - 0x5f; push(word(code.subarray(pc, pc + count))); pc += count; continue; }
    if (op >= 0x80 && op <= 0x8f) { const value = stack.at(-(op - 0x7f)); if (value === undefined) throw new Error('constructor_stack'); push(value); continue; }
    if (op >= 0x90 && op <= 0x9f) { const index = stack.length - 1 - (op - 0x8f); if (index < 0) throw new Error('constructor_stack'); [stack[index], stack[stack.length - 1]] = [stack.at(-1)!, stack[index]]; continue; }
    switch (op) {
      case 0x01: push(pop() + pop()); break;
      case 0x02: push(pop() * pop()); break;
      case 0x03: a = pop(); b = pop(); push(a - b); break;
      case 0x06: a=pop();b=pop();push(b===0n?0n:a%b);break;
      case 0x04: a = pop(); b = pop(); push(b === 0n ? 0n : a / b); break;
      case 0x0a: a = pop(); b = pop(); if (b > 256n) throw new Error('constructor_exponent'); push(a ** b); break;
      case 0x10: a = pop(); b = pop(); push(a < b ? 1n : 0n); break;
      case 0x11: a = pop(); b = pop(); push(a > b ? 1n : 0n); break;
      case 0x12: a = pop(); b = pop(); push(signed(a) < signed(b) ? 1n : 0n); break;
      case 0x13: a = pop(); b = pop(); push(signed(a) > signed(b) ? 1n : 0n); break;
      case 0x14: push(pop() === pop() ? 1n : 0n); break;
      case 0x15: push(pop() === 0n ? 1n : 0n); break;
      case 0x16: push(pop() & pop()); break;
      case 0x17: push(pop() | pop()); break;
      case 0x19: push(~pop()); break;
      case 0x1b: a = pop(); b = pop(); push(a >= 256n ? 0n : b << a); break;
      case 0x1c: a = pop(); b = pop(); push(a >= 256n ? 0n : b >> a); break;
      case 0x20: offset = number(pop()); length = number(pop()); bounds(offset, length); push(BigInt(keccak256(memory.subarray(offset, offset + length)))); break;
      case 0x30: push(BigInt(options.address));break;
      case 0x33:push(BigInt(options.caller));break;
      case 0x35:{offset=number(pop());const out=Buffer.alloc(32);calldata.copy(out,0,offset,offset+32);push(word(out));break;}
      case 0x36:push(BigInt(calldata.length));break;
      case 0x37:{offset=number(pop());const source=number(pop());length=number(pop());bounds(offset,length);memory.fill(0,offset,offset+length);calldata.copy(memory,offset,source,source+length);break;}
      case 0x42:push(options.timestamp??1000n);break;
      case 0x47:push(options.balance??1000n);break;
      case 0x5a:push(10000000n);break;
      case 0x5e:{offset=number(pop());const source=number(pop());length=number(pop());bounds(offset,length);bounds(source,length);Buffer.from(memory.subarray(source,source+length)).copy(memory,offset);break;}
      case 0x34: push(0n); break;
      case 0x46: push(56n); break;
      case 0x38: push(BigInt(code.length)); break;
      case 0x39: { offset = number(pop()); const source = number(pop()); length = number(pop()); bounds(offset, length); copies.push({pc: pc - 1, source, offset, length,step:steps}); memory.fill(0, offset, offset + length); code.copy(memory, offset, source, source + length); break; }
      case 0x50: pop(); break;
      case 0x51: offset = number(pop()); bounds(offset, 32); push(word(memory.subarray(offset, offset + 32))); break;
      case 0x52: offset = number(pop()); a = pop(); bounds(offset, 32); stores.push({pc: pc - 1, offset, value: a,step:steps}); Buffer.from(a.toString(16).padStart(64, '0'), 'hex').copy(memory, offset); break;
      case 0x54: push(storage.get(pop()) ?? 0n); break;
      case 0x55: a = pop(); b = pop(); storage.set(a, b); writes.push(a.toString()); break;
      case 0x56: pc = jump(pop()); break;
      case 0x57: a = pop(); if (pop() !== 0n) pc = jump(a); break;
      case 0x5b: break;
      case 0x5f: push(0n); break;
      case 0xa3:{offset=number(pop());length=number(pop());bounds(offset,length);const topics=[pop(),pop(),pop()].map(x=>'0x'+x.toString(16).padStart(64,'0'));logs.push({pc:pc-1,topics,data:'0x'+memory.subarray(offset,offset+length).toString('hex')});break;}
      case 0xf1:case 0xfa:{pop();const to=pop(),value=op===0xf1?pop():0n,arg=number(pop()),size=number(pop()),out=number(pop()),outSize=number(pop());bounds(arg,size);bounds(out,outSize);const data='0x'+memory.subarray(arg,arg+size).toString('hex');calls.push({pc:pc-1,kind:op===0xf1?'CALL':'STATICCALL',to:'0x'+to.toString(16).padStart(40,'0'),value:value.toString(),data});memory.fill(0,out,out+outSize);const returned=Buffer.from((op===0xfa?100n:1n).toString(16).padStart(64,'0'),'hex');returned.copy(memory,out,0,Math.min(32,outSize));push(1n);break;}
      case 0x00:return{runtime:Buffer.alloc(0),storage,writes,steps,copies,stores,returnOffset:0,returnPc:pc-1,calls,logs,visited,status:'stop'};
      case 0xfd:offset=number(pop());length=number(pop());bounds(offset,length);return{runtime:Buffer.from(memory.subarray(offset,offset+length)),storage,writes,steps,copies,stores,returnOffset:offset,returnPc:pc-1,calls,logs,visited,status:'revert'};
      case 0xf3: offset = number(pop()); length = number(pop()); bounds(offset, length); return { runtime: memory.subarray(offset, offset + length), storage, writes, steps, copies, stores, returnOffset: offset, returnPc: pc - 1,calls,logs,visited,status:'return' };
      default: throw new Error(`unaudited_constructor_opcode_${op?.toString(16)}`);
    }
  }
  throw new Error('constructor_step_limit');
}
