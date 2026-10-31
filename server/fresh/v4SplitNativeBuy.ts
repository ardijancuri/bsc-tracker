import {freshInteger,type FreshCapturedReceipt} from './capture.js';
import {freshMixedV4Settlement} from './mixedV4Settlement.js';

/** Compatibility entry for the original native-buy callers. All supported
 * split routes now share the same authenticated execution/settlement proof. */
export function freshV4SplitNativeBuy(entry:FreshCapturedReceipt,wallet:string,token:string,raw:bigint):boolean{
 try{return raw>0n&&freshInteger(entry.transaction.value)>0n&&freshMixedV4Settlement(entry,wallet,token,raw);}catch{return false;}
}