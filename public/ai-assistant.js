// =============================================================================
// AI Assistant - 可移动对话弹窗（中台接入层）
// =============================================================================
// 作为独立文件加载，不修改游戏本体任何逻辑。
// 中台不启动时，对话功能不可用，游戏正常运行。
//
// 接入中台需要准备的东西（全部在本文件内实现）：
//   1. 认证：POST /game/api/dev-login -> { token, userId }
//   2. 线程管理：生成 threadId 持久化到 localStorage，用于多轮对话上下文
//   3. 消息格式：{ id, role, content } 数组，通过 POST /agent/{agentId}/run 发送
//   4. 状态上下文：读取游戏全局 G 变量，拼成摘要塞进首条消息让 AI 感知工厂现状
//   5. SSE 流处理：解析 AG-UI 事件（TEXT_MESSAGE_CONTENT / TOOL_CALL_* / RUN_ERROR）
//   6. 错误降级：服务器不可用时只禁用对话，不报错不阻塞游戏
// =============================================================================
(function(){
"use strict";

// ===== 配置 =====
var API=window.location.origin;
var AGENT="starlink_factory";
var THREAD_KEY="ai_assistant_thread";
var MSGS_KEY="ai_assistant_messages";
var UID_KEY="ai_assistant_uid";

// ===== 运行状态 =====
var S={token:null,userId:null,connected:false,connecting:false,threadId:null,messages:[],busy:false,abortCtrl:null,panelOpen:false};
var pendingChoice=null;

// ===== 工具函数 =====
function uuid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8)}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}

// ===== 中台通用 UI 指令分发器 =====
// 统一处理所有交互工具返回的 {ui:{type,...}} 指令。
// 工具结果经 artifact 外置后，summary 里携带完整 JSON，前端解析出 ui 字段分发执行。

// DOM 引导：读 window.AI_GUIDE_MAP（target->selector），没有则按 target 当 id 试
function performGuide(target){
  var map=window.AI_GUIDE_MAP||{};
  var sel=map[target];
  var el;
  if(sel){el=document.querySelector(sel)}
  else{el=document.getElementById(target)}
  if(!el)return false;
  var card=el.closest(".card")||el.closest("[class*=panel]")||el;
  try{card.scrollIntoView({behavior:"smooth",block:"center"})}catch(e){}
  card.classList.add("ai-guide-flash");
  setTimeout(function(){card.classList.remove("ai-guide-flash")},2500);
  return true;
}

// 页面通知：优先用页面自带 toast，没有则自带
function performNotify(message,level){
  if(typeof window.aiToast==="function"){try{window.aiToast(message,level);return true}catch(e){}}
  var t=document.createElement("div");
  t.className="toast "+(level==="error"?"bad":level==="warning"?"warn":level==="success"?"good":"");
  t.textContent=message;
  var wrap=document.getElementById("toasts");
  if(!wrap){wrap=document.createElement("div");wrap.id="toasts";wrap.style.cssText="position:fixed;right:16px;bottom:16px;z-index:9999";document.body.appendChild(wrap)}
  wrap.appendChild(t);
  setTimeout(function(){t.remove()},4000);
  return true;
}

// 打开链接：外链新标签，内链当前页跳转
function performOpenLink(url,mode){
  var isExternal=/^https?:\/\//.test(url);
  var openTab=mode==="tab"||(mode!=="navigate"&&isExternal);
  if(openTab){window.open(url,"_blank");return true}
  window.location.href=url;
  return true;
}

// 统一 UI 分发：解析工具结果，按 ui.type 执行
function dispatchUI(parsed){
  if(!parsed||!parsed.ui)return null;
  var ui=parsed.ui,type=ui.type;
  if(type==="guide"){
    var ok=performGuide(ui.target);
    return{label:ui.target,ok:ok};
  }
  if(type==="notify"){
    performNotify(ui.message,ui.level);
    return{label:"["+ui.level+"] "+ui.message};
  }
  if(type==="open_link"){
    performOpenLink(ui.url,ui.mode);
    return{label:ui.label||ui.url};
  }
  if(type==="choices"){
    return{choices:ui.choices,prompt:ui.prompt};
  }
  return null;
}

// ===== 读取游戏状态快照（作为上下文发给 AI）=====
function gameSnapshot(){
  if(typeof G==="undefined"||!G)return"";
  var lines=[];
  lines.push("【工厂快照·第"+G.shift+"班】");
  lines.push("现金: Y"+G.cash+" | 声誉: "+G.reputation+"/100");
  var ms={idle:0,running:0,broken:0};
  G.machines.forEach(function(m){ms[m.status]=(ms[m.status]||0)+1});
  lines.push("设备: "+ms.running+"运行/"+ms.idle+"空闲/"+ms.broken+"故障");
  var bs={};
  G.orders.forEach(function(o){bs[o.status]=(bs[o.status]||0)+1});
  lines.push("订单: "+JSON.stringify(bs));
  if(G.tech.researched.length)lines.push("已研发科技: "+G.tech.researched.length+"项");
  if(G.tech.researching)lines.push("研发中: "+(G.tech.researching.total-G.tech.researching.remaining)+"/"+G.tech.researching.total);
  if(G.gameOver)lines.push("[工厂已破产]");
  return lines.join("\n");
}

// ===== 简化版 Markdown 渲染 =====
function md(src){
  if(!src)return"";
  src=String(src).replace(/\r/g,"");
  // code blocks
  var blocks=[];
  src=src.replace(/```([^\n`]*)\n?([\s\S]*?)```/g,function(_,lang,code){blocks.push('<pre style="background:var(--ai-bg2);border:1px solid var(--ai-border);border-radius:8px;padding:8px 10px;overflow:auto;margin:6px 0;font:11px/1.5 var(--ai-mono,monospace);color:var(--ai-amber)">'+esc(code.replace(/\n+$/,""))+"</pre>");return"\n\x01B"+(blocks.length-1)+"\x01B\n"});
  var lines=src.split("\n"),out=[],i=0;
  while(i<lines.length){
    var ln=lines[i],t=ln.trim();
    if(t.charAt(0)==="\x01"){var p=t.split("\x01");if(p[1]==="B"){out.push(blocks[+p[2]]);i++;continue}}
    var m;
    if(m=t.match(/^(#{1,4})\s+(.*)$/)){var L=m[1].length;out.push('<h'+L+' style="margin:8px 0 4px;font-weight:700;font-size:'+(17-L*2)+'px;color:var(--ai-cyan)">'+mdInline(m[2])+'</h'+L+">");i++;continue}
    if((m=t.match(/^[-*]\s+(.*)$/))||(m=t.match(/^\d+\.\s+(.*)$/))){
      var items=[],ordered=/^\d+\./.test(t);
      while(i<lines.length){var tt=lines[i].trim();var lm=tt.match(/^[-*]\s+(.*)$/);var om=tt.match(/^\d+\.\s+(.*)$/);if(ordered&&om){items.push(mdInline(om[1]));i++}else if(!ordered&&lm){items.push(mdInline(lm[1]));i++}else break}
      out.push((ordered?"<ol>":"<ul>")+"<li style='margin:2px 0'>"+items.join("</li><li style='margin:2px 0'>")+"</li>"+(ordered?"</ol>":"</ul>"));continue}
    if(!t){i++;continue}
    var para=[];
    while(i<lines.length){var tt=lines[i].trim();if(!tt||tt.charAt(0)==="\x01"||/^#{1,4}\s/.test(tt)||/^[-*]\s/.test(tt)||/^\d+\.\s/.test(tt))break;para.push(tt);i++}
    out.push("<p style='margin:5px 0'>"+para.map(mdInline).join("<br>")+"</p>");
  }
  return out.join("");
}
function mdInline(s){
  s=s.replace(/`([^`]+)`/g,function(_,c){return"<code style='background:var(--ai-bg2);padding:1px 5px;border-radius:4px;font:11px monospace;color:var(--ai-amber)'>"+esc(c)+"</code>"});
  s=s.replace(/\*\*([^*]+?)\*\*/g,"<strong style='color:#fff'>$1</strong>");
  s=s.replace(/\*([^*]+?)\*/g,"<em style='color:var(--ai-violet);font-style:normal'>$1</em>");
  s=esc(s).replace(/&lt;strong&gt;/g,"<strong>").replace(/&lt;\/strong&gt;/g,"</strong>").replace(/&lt;em&gt;/g,"<em>").replace(/&lt;\/em&gt;/g,"</em>");
  return s;
}

// ===== 注入样式 =====
var css=document.createElement("style");
css.textContent=
":root{--ai-bg2:#0b0f16;--ai-border:rgba(120,170,210,.14);--ai-border2:rgba(120,170,210,.28);"+
"--ai-cyan:#39d0ff;--ai-green:#3ddc97;--ai-amber:#ffb24a;--ai-red:#ff6b7b;--ai-violet:#a78bfa;--ai-blue:#5b8bff;"+
"--ai-dim:#8c99a8;--ai-faint:#586472;--ai-txt:#e8eef5;--ai-mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace}"+
".ai-fab{position:fixed;right:24px;bottom:24px;width:54px;height:54px;border-radius:50%;border:none;cursor:pointer;"+
"background:linear-gradient(135deg,#39d0ff,#5b8bff);box-shadow:0 4px 20px rgba(57,208,255,.4);z-index:9000;"+
"display:grid;place-items:center;transition:transform .2s,box-shadow .2s}"+
".ai-fab:hover{transform:scale(1.08);box-shadow:0 6px 28px rgba(57,208,255,.55)}"+
".ai-fab svg{width:26px;height:26px;fill:#04111a}"+
".ai-fab .ai-fab-dot{position:absolute;top:2px;right:2px;width:12px;height:12px;border-radius:50%;border:2px solid #070b11}"+
".ai-fab .ai-fab-dot.online{background:var(--ai-green)}.ai-fab .ai-fab-dot.connecting{background:var(--ai-amber);animation:aipulse 1s ease infinite}"+
".ai-fab .ai-fab-dot.offline{background:var(--ai-faint)}"+
"@keyframes aipulse{50%{opacity:.3}}"+
".ai-panel{position:fixed;width:386px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 100px);"+
"right:24px;bottom:88px;background:#0f141d;border:1px solid var(--ai-border2);border-radius:16px;"+
"box-shadow:0 20px 60px rgba(0,0,0,.6);z-index:9001;display:flex;flex-direction:column;overflow:hidden;"+
"font:13px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:var(--ai-txt)"+
"}.ai-panel.hide{display:none}"+
".ai-panel-head{height:46px;display:flex;align-items:center;gap:10px;padding:0 14px;cursor:move;user-select:none;"+
"background:linear-gradient(135deg,rgba(57,208,255,.08),rgba(91,139,255,.05));border-bottom:1px solid var(--ai-border);flex:0 0 auto}"+
".ai-panel-head .ai-h-icon{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#39d0ff,#5b8bff);display:grid;place-items:center;flex:0 0 auto}"+
".ai-panel-head .ai-h-icon svg{width:16px;height:16px;fill:#04111a}"+
".ai-panel-head .ai-h-title{font-size:13px;font-weight:700;flex:1;min-width:0}"+
".ai-panel-head .ai-h-title .ai-h-sub{font-size:10px;font-weight:400;color:var(--ai-faint);font-family:var(--ai-mono)}"+
".ai-panel-head .ai-h-close{width:28px;height:28px;border-radius:7px;border:1px solid var(--ai-border);background:transparent;color:var(--ai-dim);cursor:pointer;font-size:16px;display:grid;place-items:center;transition:.15s;flex:0 0 auto}"+
".ai-panel-head .ai-h-close:hover{border-color:var(--ai-red);color:var(--ai-red);background:rgba(255,107,123,.08)}"+
".ai-panel-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px}"+
".ai-panel-body::-webkit-scrollbar{width:7px}.ai-panel-body::-webkit-scrollbar-thumb{background:#1d2733;border-radius:6px}"+
".ai-msg{max-width:92%;padding:9px 13px;border-radius:13px;font-size:13px;line-height:1.6;word-break:break-word;animation:aifade .25s ease}"+
"@keyframes aifade{from{opacity:0;transform:translateY(4px)}to{opacity:1}}"+
".ai-msg.user{align-self:flex-end;background:linear-gradient(180deg,rgba(57,208,255,.16),rgba(91,139,255,.13));border:1px solid rgba(57,208,255,.28);color:#eaf6ff}"+
".ai-msg.ai{align-self:flex-start;background:#17222f;border:1px solid var(--ai-border);max-width:100%}"+
".ai-msg.sys{align-self:center;background:transparent;color:var(--ai-faint);font-size:11px;border:1px dashed var(--ai-border2);text-align:center;max-width:100%}"+
".ai-tool{align-self:flex-start;background:#0b0f16;border:1px solid var(--ai-border);border-left:3px solid var(--ai-cyan);border-radius:9px;padding:8px 11px;font-size:11.5px;width:92%;max-width:92%}"+
".ai-tool .ai-t-name{font-family:var(--ai-mono);color:var(--ai-cyan);font-size:11px;margin-bottom:3px}"+
".ai-tool .ai-t-result{color:var(--ai-dim);font-size:11px;margin-top:4px;max-height:60px;overflow:hidden;word-break:break-all}"+
".ai-tool .ai-t-result.ok{color:var(--ai-green)}.ai-tool .ai-t-result.err{color:var(--ai-red)}"+
".ai-thinking{align-self:flex-start;display:inline-flex;gap:5px;align-items:center;padding:6px}"+
".ai-thinking i{width:6px;height:6px;border-radius:50%;background:var(--ai-cyan);animation:aidot 1.3s ease infinite}"+
".ai-thinking i:nth-child(2){animation-delay:.15s}.ai-thinking i:nth-child(3){animation-delay:.3s}"+
"@keyframes aidot{0%,60%,100%{transform:translateY(0);opacity:.3}30%{transform:translateY(-4px);opacity:1}}"+
".ai-panel-quick{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 6px;flex:0 0 auto}"+
".ai-panel-quick button{font-size:11px;padding:4px 10px;border-radius:14px;background:transparent;border:1px solid var(--ai-border);color:var(--ai-dim);cursor:pointer;font-family:inherit;transition:.14s}"+
".ai-panel-quick button:hover{color:var(--ai-cyan);border-color:rgba(57,208,255,.4);background:rgba(57,208,255,.06)}"+
".ai-panel-foot{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--ai-border);flex:0 0 auto;background:#0b0f16}"+
".ai-panel-foot textarea{flex:1;resize:none;height:44px;background:#070b11;border:1px solid var(--ai-border);border-radius:10px;color:var(--ai-txt);padding:10px;font:13px/1.5 inherit;font-family:inherit}"+
".ai-panel-foot textarea:focus{outline:none;border-color:var(--ai-cyan);box-shadow:0 0 0 3px rgba(57,208,255,.12)}"+
".ai-panel-foot .ai-send{padding:0 14px;border-radius:10px;border:none;background:linear-gradient(135deg,#39d0ff,#5b8bff);color:#04111a;font-weight:700;font-size:13px;cursor:pointer;transition:.15s;flex:0 0 auto}"+
".ai-panel-foot .ai-send:hover{filter:brightness(1.1)}.ai-panel-foot .ai-send:disabled{opacity:.35;cursor:not-allowed}"+
".ai-panel-foot .ai-stop{padding:0 12px;border-radius:10px;border:1px solid var(--ai-border2);background:transparent;color:var(--ai-dim);font-size:12px;cursor:pointer;flex:0 0 auto}"+
".ai-panel-foot .ai-stop:hover{border-color:var(--ai-red);color:var(--ai-red)}"+
".ai-status-bar{padding:4px 14px;font-size:10px;font-family:var(--ai-mono);color:var(--ai-faint);border-bottom:1px solid var(--ai-border);flex:0 0 auto;display:flex;align-items:center;gap:6px}"+
".ai-status-bar .ai-sb-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}"+
".ai-status-bar .ai-sb-dot.online{background:var(--ai-green)}.ai-status-bar .ai-sb-dot.offline{background:var(--ai-faint)}.ai-status-bar .ai-sb-dot.connecting{background:var(--ai-amber)}"+
".ai-guide-flash{position:relative;z-index:8}"+
".ai-guide-flash::after{content:\"\";position:absolute;inset:0;border-radius:inherit;border:2px solid var(--ai-cyan);pointer-events:none;animation:aiguidepulse .6s ease 4}"+
"@keyframes aiguidepulse{0%,100%{opacity:1;box-shadow:0 0 24px rgba(57,208,255,.55)}50%{opacity:.25;box-shadow:0 0 6px rgba(57,208,255,.15)}}"+
"@media(max-width:560px){.ai-panel{right:12px;left:12px;width:auto;bottom:80px}}";
".ai-choices{display:flex;flex-wrap:wrap;gap:7px;padding:2px 0}"+
".ai-choice-btn{padding:6px 14px;border-radius:9px;border:1px solid var(--ai-border2);background:var(--ai-bg2);color:var(--ai-txt);font-size:12px;cursor:pointer;font-family:inherit;transition:.15s;white-space:nowrap}"+
".ai-choice-btn:hover{border-color:var(--ai-cyan);background:rgba(57,208,255,.1)}"+
".ai-choice-btn.primary{background:linear-gradient(135deg,var(--ai-cyan),var(--ai-blue));color:#04111a;border:none;font-weight:700}"+
".ai-choice-btn.success{border-color:rgba(61,220,151,.4);color:var(--ai-green)}"+
".ai-choice-btn.warning{border-color:rgba(255,178,74,.4);color:var(--ai-amber)}"+
".ai-choice-btn.danger{border-color:rgba(255,107,123,.4);color:var(--ai-red)}"+
".ai-choice-btn:disabled{opacity:.4;cursor:default}"+
".ai-choice-prompt{font-size:12px;color:var(--ai-dim);margin-bottom:4px}"+
".ai-tool.ui-choices{border-left-color:var(--ai-violet)}";
document.head.appendChild(css);

// ===== SVG 图标 =====
var CHAT_SVG='<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
var ROBOT_SVG='<svg viewBox="0 0 24 24"><path d="M12 2a2 2 0 012 2c0 .74-.4 1.38-1 1.72v1.28h3a3 3 0 013 3v1h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a3 3 0 01-3 3H8a3 3 0 01-3-3v-1H4a1 1 0 01-1-1v-3a1 1 0 011-1h1V9a3 3 0 013-3h3V5.72A2 2 0 0110 4a2 2 0 012-2zM9 13a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm6 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/></svg>';

// ===== 构建 DOM =====
// 浮动按钮
var fab=document.createElement("button");
fab.className="ai-fab";
fab.innerHTML=CHAT_SVG+'<span class="ai-fab-dot offline"></span>';
fab.title="AI 助手";
document.body.appendChild(fab);

// 对话面板
var panel=document.createElement("div");
panel.className="ai-panel hide";
panel.innerHTML=
'<div class="ai-panel-head" id="ai-head">'+
  '<div class="ai-h-icon">'+ROBOT_SVG+'</div>'+
  '<div class="ai-h-title">AI 助手<span class="ai-h-sub" id="ai-sub"> 未连接</span></div>'+
  '<button class="ai-h-close" id="ai-close">&times;</button>'+
'</div>'+
'<div class="ai-status-bar" id="ai-status-bar"><span class="ai-sb-dot offline" id="ai-sb-dot"></span><span id="ai-sb-txt">未连接中台</span></div>'+
'<div class="ai-panel-body" id="ai-body"></div>'+
'<div class="ai-panel-quick" id="ai-quick">'+
  '<button data-q="帮我看看当前工厂状况，有什么建议？">查看工厂状况</button>'+
  '<button data-q="哪些订单最紧急？优先级怎么排？">订单优先级</button>'+
  '<button data-q="帮我规划接下来的生产计划">生产规划</button>'+
'</div>'+
'<div class="ai-panel-foot">'+
  '<textarea id="ai-input" placeholder="问 AI 助手..." rows="1"></textarea>'+
  '<button class="ai-send" id="ai-send">发送</button>'+
  '<button class="ai-stop" id="ai-stop" style="display:none">停止</button>'+
'</div>';
document.body.appendChild(panel);

// ===== 拖拽逻辑 =====
var dragState={dragging:false,offX:0,offY:0};
function startDrag(e){
  var touch=e.touches?e.touches[0]:e;
  var rect=panel.getBoundingClientRect();
  dragState.dragging=true;
  dragState.offX=touch.clientX-rect.left;
  dragState.offY=touch.clientY-rect.top;
  panel.style.transition="none";
  e.preventDefault();
}
function onDrag(e){
  if(!dragState.dragging)return;
  var touch=e.touches?e.touches[0]:e;
  var x=touch.clientX-dragState.offX;
  var y=touch.clientY-dragState.offY;
  x=Math.max(0,Math.min(window.innerWidth-panel.offsetWidth,x));
  y=Math.max(0,Math.min(window.innerHeight-panel.offsetHeight,y));
  panel.style.left=x+"px";
  panel.style.top=y+"px";
  panel.style.right="auto";
  panel.style.bottom="auto";
  e.preventDefault();
}
function endDrag(){dragState.dragging=false;panel.style.transition=""}
var headEl=document.getElementById("ai-head");
headEl.addEventListener("mousedown",startDrag);
headEl.addEventListener("touchstart",startDrag,{passive:false});
document.addEventListener("mousemove",onDrag);
document.addEventListener("touchmove",onDrag,{passive:false});
document.addEventListener("mouseup",endDrag);
document.addEventListener("touchend",endDrag);

// ===== 面板开关 =====
var fabDot=fab.querySelector(".ai-fab-dot");
function togglePanel(){
  if(S.panelOpen){panel.classList.add("hide");S.panelOpen=false}
  else{panel.classList.remove("hide");S.panelOpen=true;if(!S.connected&&!S.connecting)connect()}
}
fab.addEventListener("click",togglePanel);
document.getElementById("ai-close").addEventListener("click",togglePanel);

// ===== 连接状态管理 =====
function setConnStatus(state,txt){
  var dotCls={online:"online",offline:"offline",connecting:"connecting"}[state]||"offline";
  fabDot.className="ai-fab-dot "+dotCls;
  var sbDot=document.getElementById("ai-sb-dot");
  sbDot.className="ai-sb-dot "+dotCls;
  document.getElementById("ai-sb-txt").textContent=txt||"";
  document.getElementById("ai-sub").textContent=" "+(txt||"");
}

// ===== 连接中台 =====
async function connect(){
  if(S.connecting||S.connected)return;
  S.connecting=true;
  setConnStatus("connecting","正在连接...");
  try{
    // 从 localStorage 恢复 userId（使服务端状态跨刷新保留）
    var savedUid=null;
    try{savedUid=localStorage.getItem(UID_KEY)}catch(e){}
    var body=savedUid?{userId:savedUid}:{};
    var resp=await fetch(API+"/game/api/dev-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if(!resp.ok)throw new Error("dev-login "+resp.status);
    var j=await resp.json();
    S.token=j.token;S.userId=j.userId;S.connected=true;S.connecting=false;
    try{localStorage.setItem(UID_KEY,S.userId)}catch(e){}
    // 恢复或创建线程
    try{S.threadId=localStorage.getItem(THREAD_KEY)}catch(e){}
    if(!S.threadId){S.threadId=uuid();try{localStorage.setItem(THREAD_KEY,S.threadId)}catch(e){}}
    // 恢复消息历史
    try{var saved=localStorage.getItem(MSGS_KEY);if(saved)S.messages=JSON.parse(saved)}catch(e){}
    setConnStatus("online","已连接 "+S.userId);
    renderMessages();
    if(S.messages.length===0)addSysMsg("已连入工厂中台，向 AI 助手提问即可。AI 能看到你的工厂实时状态。");
  }catch(e){
    S.connecting=false;S.connected=false;
    setConnStatus("offline","中台未连接");
    renderMessages();
    addSysMsg("中台未启动，对话不可用。启动后端(npm run dev, 端口9876)后重试。游戏本身不受影响。");
  }
}

// ===== 渲染消息 =====
var bodyEl=document.getElementById("ai-body");
function saveMsgs(){try{localStorage.setItem(MSGS_KEY,JSON.stringify(S.messages))}catch(e){}}
function renderMessages(){
  bodyEl.innerHTML="";
  for(var i=0;i<S.messages.length;i++){
    var m=S.messages[i];
    if(m.role==="user")addMsgEl("user",m.content);
    else if(m.role==="assistant")addMsgEl("ai",m.content,true);
    else if(m.role==="system")addSysMsg(m.content);
  }
  scrollBody();
}
function addMsgEl(cls,text,isMd){
  var d=document.createElement("div");
  d.className="ai-msg "+cls;
  if(isMd)d.innerHTML=md(text);else d.textContent=text==null?"":text;
  bodyEl.appendChild(d);scrollBody();return d;
}
function addSysMsg(text){
  var d=document.createElement("div");
  d.className="ai-msg sys";d.textContent=text;
  bodyEl.appendChild(d);scrollBody();
}
function addToolCard(name,args,result){
  var d=document.createElement("div");
  d.className="ai-tool";
  var html='<div class="ai-t-name">'+esc(name)+'</div>';
  if(args)html+='<div style="color:var(--ai-dim);font-size:10px">'+esc(typeof args==="string"?args:JSON.stringify(args))+'</div>';
  if(result!=null){
    var ok=true;var txt=result;
    if(typeof result==="string"){try{var o=JSON.parse(result);if(o&&o.ok===false){ok=false;txt=o.message||result}}catch(e){}}
    html+='<div class="ai-t-result '+(ok?"ok":"err")+'">'+esc(typeof txt==="string"?txt:JSON.stringify(txt))+'</div>';
  }
  d.innerHTML=html;
  bodyEl.appendChild(d);scrollBody();return d;
}
function addThinking(){
  var d=document.createElement("div");
  d.className="ai-thinking";d.innerHTML="<i></i><i></i><i></i>";
  bodyEl.appendChild(d);scrollBody();return d;
}
function scrollBody(){bodyEl.scrollTop=bodyEl.scrollHeight}
function saveMsg(role,content){S.messages.push({role:role,content:content});saveMsgs()}

// ===== 发送消息 =====
var inputEl=document.getElementById("ai-input");
var sendBtn=document.getElementById("ai-send");
var stopBtn=document.getElementById("ai-stop");

function setBusy(b){
  S.busy=b;
  sendBtn.style.display=b?"none":"block";
  stopBtn.style.display=b?"block":"none";
  inputEl.disabled=b;
}

async function sendMessage(text){
  text=(text||inputEl.value).trim();
  if(!text||S.busy)return;
  if(!S.connected){addSysMsg("中台未连接，无法发送消息。");return}
  inputEl.value="";
  // 用户消息显示 + 存储
  addMsgEl("user",text);
  // 构建发给中台的消息列表（首条消息附带游戏状态快照）
  var contextPrefix="";
  var snap=gameSnapshot();
  if(snap)contextPrefix="[当前工厂状态]\n"+snap+"\n\n";
  var msgContent=contextPrefix+text;
  saveMsg("user",text);
  // 构建消息体（发给 AG-UI 的 messages 需要完整历史）
  var agMessages=S.messages.map(function(m){return{id:uuid(),role:m.role,content:m.role==="user"&&m===S.messages[S.messages.length-1]?msgContent:m.content}});
  setBusy(true);
  var thinkingEl=addThinking();
  S.abortCtrl=new AbortController();
  // 流式渲染状态
  var aiBubble=null,aiText="",stepMap={},stepCount=0;
  try{
    var resp=await fetch(API+"/agent/"+AGENT+"/run",{
      method:"POST",
      headers:{"Authorization":"Bearer "+S.token,"Content-Type":"application/json"},
      body:JSON.stringify({threadId:S.threadId,runId:uuid(),state:{},messages:agMessages,tools:[],context:[]}),
      signal:S.abortCtrl.signal
    });
    if(!resp.ok||!resp.body){
      var errTxt=await resp.text().catch(function(){return""});
      if(thinkingEl)thinkingEl.remove();
      addSysMsg("请求失败 "+resp.status+(errTxt?(" "+errTxt.slice(0,120)):""));
      setBusy(false);return;
    }
    await streamSSE(resp.body,function(ev){
      var t=ev.type;
      if(t==="TEXT_MESSAGE_CONTENT"){
        var delta=ev.delta||"";
        if(delta){
          if(thinkingEl){thinkingEl.remove();thinkingEl=null}
          if(!aiBubble){aiBubble=addMsgEl("ai","",true)}
          aiText+=delta;
          aiBubble.innerHTML=md(aiText);
          scrollBody();
        }
      }else if(t==="TOOL_CALL_START"){
        if(thinkingEl){thinkingEl.remove();thinkingEl=null}
        stepCount++;
        var tc=document.createElement("div");
        tc.className="ai-tool";
        tc.innerHTML='<div class="ai-t-name">'+stepCount+'. '+esc(ev.toolCallName||"tool")+'</div><div style="color:var(--ai-dim);font-size:10px">执行中...</div>';
        bodyEl.appendChild(tc);scrollBody();
        stepMap[ev.toolCallId]={el:tc,name:ev.toolCallName,args:""};
      }else if(t==="TOOL_CALL_ARGS"){
        var s=stepMap[ev.toolCallId];
        if(s){s.args+=(ev.delta||"");s.el.querySelector("div:last-child").textContent=s.args.slice(0,200)}
     }else if(t==="TOOL_CALL_RESULT"){
       var s=stepMap[ev.toolCallId];
       if(s){
         var content=ev.content;
        if(Array.isArray(content))content=content.map(function(p){return p&&p.text||""}).join("");
          if(Array.isArray(content))content=content.map(function(p){return p&&p.text||""}).join("");
          // 统一 UI 指令分发：解析 {ui:{type,...}} 并执行对应前端动作
          var parsed=null,uiResult=null;
          try{
            parsed=JSON.parse(content);
            if(parsed&&parsed.summary&&typeof parsed.summary==="string"){parsed=JSON.parse(parsed.summary)}
          }catch(e){}
          if(parsed&&parsed.ui){
            uiResult=dispatchUI(parsed);
            s.el.className="ai-tool ui-"+parsed.ui.type;
            var hintTxt=parsed.hint||(uiResult?uiResult.label:"")||parsed.ui.type;
            if(uiResult&&uiResult.choices){
              var cp=document.createElement("div");cp.className="ai-choice-prompt";cp.textContent=uiResult.prompt||"";
              var cb=document.createElement("div");cb.className="ai-choices";
              uiResult.choices.forEach(function(ch){
                var b=document.createElement("button");
                b.className="ai-choice-btn "+(ch.style||"default");
                b.textContent=ch.label;
                b.addEventListener("click",function(){
                  var all=cb.querySelectorAll("button");
                  for(var i=0;i<all.length;i++){all[i].disabled=true}
                  b.style.borderColor="var(--ai-green)";b.style.color="var(--ai-green)";
                  if(S.busy){pendingChoice=ch.value;addSysMsg("AI 回复完成后自动发送你的选择")}
                  else{sendMessage(ch.value)}
                });
                cb.appendChild(b);
              });
              s.el.innerHTML='<div class="ai-t-name">'+esc(s.name)+'</div>';
              s.el.appendChild(cp);s.el.appendChild(cb);
            }else{
              s.el.innerHTML='<div class="ai-t-name">'+esc(s.name)+'</div><div class="ai-t-result ok">'+esc(hintTxt)+'</div>';
            }
            scrollBody();
          }else{
            // 普通工具：通用展示
            var ok=true,txt=content||"";
            if(typeof txt==="string"){try{var o=JSON.parse(txt);if(o&&o.ok===false)ok=false;txt=o.message||txt}catch(e){}}
            s.el.innerHTML='<div class="ai-t-name">'+esc(s.name)+'</div><div class="ai-t-result '+(ok?"ok":"err")+'">'+esc(String(txt).slice(0,300))+'</div>';
            scrollBody();
          }
        }
      }else if(t==="RUN_ERROR"){
        if(thinkingEl){thinkingEl.remove();thinkingEl=null}
        addSysMsg("运行错误: "+(ev.message||ev.error||""));
      }
    });
    if(thinkingEl)thinkingEl.remove();
    // 保存 AI 回复
    if(aiText){saveMsg("assistant",aiText)}
    else if(stepCount>0){saveMsg("assistant","(已执行 "+stepCount+" 个操作，详见上方工具卡片)")}
  }catch(e){
    if(thinkingEl)thinkingEl.remove();
    if(e.name==="AbortError")addSysMsg("(已停止)");
    else addSysMsg("连接错误: "+e.message);
    if(aiText)saveMsg("assistant",aiText);
 }
  setBusy(false);
  // 自动发送排队的选项点击（用户在 AI 回复过程中点了选项按钮）
  if(pendingChoice){var pc=pendingChoice;pendingChoice=null;sendMessage(pc)}
}

// ===== SSE 流解析（AG-UI 协议）=====
async function streamSSE(body,onEvent){
  var reader=body.getReader(),dec=new TextDecoder(),buf="";
  while(true){
    var r=await reader.read();
    if(r.done)break;
    buf+=dec.decode(r.value,{stream:true});
    var i;
    while((i=buf.indexOf("\n\n"))!==-1){
      var blk=buf.slice(0,i);
      buf=buf.slice(i+2);
      var dl=[];
      var lines=blk.split("\n");
      for(var j=0;j<lines.length;j++){
        if(lines[j].indexOf("data:")===0)dl.push(lines[j].slice(5).replace(/^ /,""));
      }
      if(!dl.length)continue;
      var payload=dl.join("\n");
      if(payload==="[DONE]")continue;
      try{onEvent(JSON.parse(payload))}catch(e){}
    }
  }
  if(buf.trim()){
    var dl2=[];var lines2=buf.split("\n");
    for(var j=0;j<lines2.length;j++){if(lines2[j].indexOf("data:")===0)dl2.push(lines2[j].slice(5).replace(/^ /,""))}
    if(dl2.length){var p2=dl2.join("\n");if(p2!=="[DONE]"){try{onEvent(JSON.parse(p2))}catch(e){}}}
  }
}

// ===== 事件绑定 =====
sendBtn.addEventListener("click",function(){sendMessage()});
stopBtn.addEventListener("click",function(){if(S.abortCtrl)S.abortCtrl.abort()});
inputEl.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage()}});
inputEl.addEventListener("input",function(){inputEl.style.height="auto";inputEl.style.height=Math.min(inputEl.scrollHeight,80)+"px"});
var quickBtns=document.getElementById("ai-quick").querySelectorAll("button");
for(var i=0;i<quickBtns.length;i++){quickBtns[i].addEventListener("click",function(){sendMessage(this.dataset.q)})}

// 面板首次打开时自动连接
// （connect 在 togglePanel 里触发）
})();
