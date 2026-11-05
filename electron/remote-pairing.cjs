"use strict";

/** Accepts a whole pairing link or its bare 43-character grant; returns null
 * for anything else. Embedded verbatim into the page script below. */
function parsePairingInput(text) {
	const grantPattern = /^[A-Za-z0-9_-]{43}$/;
	const value = String(text).trim();
	if (grantPattern.test(value)) return value;
	try {
		const grant = new URLSearchParams(new URL(value).hash.slice(1)).get("grant");
		if (grant && grantPattern.test(grant)) return grant;
	} catch {}
	return null;
}

/** The grant is read from the fragment (or pasted, for Home Screen web apps
 * whose URL cannot be edited), removed from history, then posted.
 * It never enters a request URL, referrer, repository, or application log. */
function pairingPage(nonce) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to LearnHarness</title><style>
html{color-scheme:dark;font:16px/1.6 system-ui;background:#111412;color:#e4e8e2}body{margin:0;min-height:100dvh;display:grid;place-items:center}main{max-width:28rem;padding:2rem}h1{font:2rem Georgia,serif}p{color:#b1bcb2}button{font:inherit;padding:.75rem 1rem;border:1px solid #657c68;border-radius:.5rem;background:#233b2a;color:inherit;cursor:pointer}button:disabled{opacity:.5}#message{min-height:3rem}label{display:block;color:#b1bcb2;margin-bottom:.4rem}input{box-sizing:border-box;width:100%;font:inherit;padding:.65rem .75rem;border:1px solid #657c68;border-radius:.5rem;background:#1a201c;color:inherit}.actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.75rem}
</style></head><body><main><p>LEARNHARNESS · REMOTE ACCESS</p><h1>Connect this device</h1><p>Use the one-time pairing link from Settings → Remote Access on your laptop. Only pair a device you trust with your learning records and settings.</p><label for="link">Paste pairing link or code</label><input id="link" type="text" inputmode="url" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"><div class="actions"><button id="paste" type="button">Paste</button><button id="connect" type="button" hidden>Pair this device</button></div><p id="message" role="status"></p></main><script nonce="${nonce}">
let grant=null;
const button=document.querySelector('#connect'),message=document.querySelector('#message'),field=document.querySelector('#link'),paste=document.querySelector('#paste');
const idle='Paste a fresh pairing link to continue.';
${parsePairingInput.toString()}
function tail(value){return value.slice(-6)}
function ready(value){grant=value;button.hidden=false;button.disabled=false;message.textContent='Ready to pair link ending …'+tail(value)+'. Tap Pair within a few minutes.'}
function receiveGrant(){const incoming=new URLSearchParams(location.hash.slice(1)).get('grant');history.replaceState(null,'','/_lh/remote/pair');if(incoming)ready(incoming);else if(!grant)message.textContent=idle}
function receivePasted(){const value=field.value.trim();const pasted=parsePairingInput(value);if(pasted)return ready(pasted);grant=null;button.hidden=true;message.textContent=value?"That isn't a pairing link. Copy the whole link and try again.":idle}
receiveGrant();addEventListener('hashchange',receiveGrant);field.addEventListener('input',receivePasted);
paste.onclick=async()=>{try{if(!navigator.clipboard||!navigator.clipboard.readText)throw new Error('unavailable');field.value=await navigator.clipboard.readText();receivePasted()}catch{message.textContent='Tap the box and paste instead.';field.focus()}};
button.onclick=async()=>{button.disabled=true;try{
if(!navigator.serviceWorker)throw new Error('Use Safari or Chrome with browser storage enabled to pair this device.');
await navigator.serviceWorker.register('/_lh/remote/sw.js',{scope:'/'});
const registration=await navigator.serviceWorker.ready;
const response=await fetch('/_lh/remote/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant})});grant=null;
if(!response.ok)throw new Error('This link expired or was already used (HTTP '+response.status+'). Create a new pairing link on your laptop.');
const result=await response.json();
await new Promise((resolve,reject)=>{const channel=new MessageChannel();const timeout=setTimeout(()=>reject(new Error('Browser storage is unavailable. Enable storage and try a fresh pairing link.')),10000);channel.port1.onmessage=(event)=>{clearTimeout(timeout);channel.port1.close();event.data.ok?resolve():reject(new Error('Pairing could not be saved in this browser.'))};registration.active.postMessage({type:'pair',token:result.token},[channel.port2])});
field.value='';location.replace('/')
}catch(error){message.textContent=error.message;button.hidden=true}};
</script></body></html>`;
}

module.exports = { pairingPage, parsePairingInput };
