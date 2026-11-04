import {browserApi as chrome} from './platform';
chrome.runtime.onMessage.addListener((message:any,sender:any,respond:(value:unknown)=>void)=>{
  if(message?.kind!=='audio/beep'||sender.id!==chrome.runtime.id||sender.tab||(sender.url&&sender.url!==chrome.runtime.getURL('background.js')))return;
  const context=new AudioContext(),oscillator=context.createOscillator(),gain=context.createGain();
  oscillator.connect(gain);gain.connect(context.destination);oscillator.frequency.value=660;
  gain.gain.setValueAtTime(.07,context.currentTime);gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.18);
  void Promise.race([context.resume(),new Promise((_,reject)=>setTimeout(()=>reject(Error('audio_blocked')),1500))]).then(()=>{
    oscillator.start();oscillator.stop(context.currentTime+.18);oscillator.onended=()=>{respond({played:true});void context.close();};
  },()=>{respond({played:false});void context.close();});return true;
});
