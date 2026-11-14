/** Every executable HTML/shell script starts here, including a hash-authorized copy in a fresh realm. */
export const HTML_NETWORK_LOCKDOWN = `(function(g){
  var define = ({}).constructor.defineProperty;
  var proto = ({}).constructor.getPrototypeOf;
  function lock(target,key){
    if (!target) return;
    try { define(target,key,{configurable:false,writable:false,value:void 0}); } catch (_) {}
  }
  ["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection","RTCDataChannel","RTCRtpSender","RTCRtpReceiver",
    "RTCIceCandidate","WebTransport","WebSocket","EventSource","fetch","XMLHttpRequest"].forEach(function(key){lock(g,key);});
  var nav = g.navigator;
  ["mediaDevices","sendBeacon","getUserMedia","webkitGetUserMedia","mozGetUserMedia"].forEach(function(key){
    lock(nav,key);
    var p = proto(nav);
    while(p && p!==proto({})){lock(p,key);p=proto(p);}
  });
})(this);\n`;

/** Only the trusted shell retains its native message bridge; opaque agent realms never receive it. */
export const HTML_LOCKDOWN =
  HTML_NETWORK_LOCKDOWN +
  `(function(g){try{({}).constructor.defineProperty(g,"ReactNativeWebView",{configurable:false,writable:false,value:void 0});}catch(_){}})(this);\n`;

/** Trusted bootstrap only. The port never carries credentials or application state. */
export function htmlBootstrap(instance: string, nonce: string): string {
  return (
    HTML_LOCKDOWN +
    `(function(){
    var port, timer;
    var send = function(type){if(port)port.postMessage({type:type,height:Math.min(1000000,document.documentElement.scrollHeight)});};
    window.addEventListener("message",function(event){
      var d=event.data;
      if(port || event.source!==parent || !d || d.type!=="connect" || d.canopy_visual!==1 ||
        d.instance!==${JSON.stringify(instance)} || d.nonce!==${JSON.stringify(nonce)} || !event.ports[0]) return;
      port=event.ports[0];send("ready");
      port.onmessage=function(received){
        var m=received.data;
        if(!m || m.type!=="theme" || !m.theme || !m.theme.colors) return;
        ["canvas","surface","panel","hover","ink","muted","border","accent","action","action-hover","on-accent","info","success","warning","danger"].forEach(function(key){
          var color=m.theme.colors[key];
          if(typeof color==="string" && /^(#[0-9a-fA-F]{3,8}|color-mix\\(in oklab, #[0-9a-fA-F]{3,8} \\d{1,3}%, #[0-9a-fA-F]{3,8}\\))$/.test(color))document.documentElement.style.setProperty("--canopy-"+key,color);
        });
        if(m.theme.mode==="light" || m.theme.mode==="dark")document.documentElement.style.colorScheme=m.theme.mode;
      };
      timer=setInterval(function(){send("height");},1000);
    });
    document.addEventListener("keydown",function(e){if(e.key==="Escape" && port)port.postMessage({type:"escape"});});
    document.addEventListener("click",function(e){if(e.target.closest && e.target.closest("a"))e.preventDefault();},true);
    document.addEventListener("submit",function(e){e.preventDefault();},true);
    window.addEventListener("error",function(){if(port)port.postMessage({type:"render_error",message:"Script error"});});
  })();`
  );
}
