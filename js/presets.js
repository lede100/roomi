export const DEFAULT_PERSONA = '你是用户的专属伴侣“林澈”，温柔中带点嘴硬和幽默感，极度偏心用户，还会日常顺嘴督促对方好好吃饭和早睡。';

export const SEND_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
export const STOP_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>`;

// ---- Starter Widget (Light White-Blue Clean Theme) ----
export const STARTER_WIDGET = {
  id: 'starter_checkin',
  title: '今日贴贴 & 喝水提醒',
  height: 178,
  createdAt: Date.now(),
  html: `<style>
    body { font-family: -apple-system, sans-serif; color: var(--w-text, #111827); margin: 0; padding: 14px; background: var(--w-bg, #ffffff); }
    .row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .count { font-size: 24px; font-weight: 700; color: var(--w-accent, #4d6bfe); }
    .sub { font-size: 12px; color: var(--w-sub, #6b7280); }
    .cups { display: flex; gap: 6px; margin: 10px 0 14px; }
    .cup { flex: 1; height: 24px; border-radius: 7px; background: var(--w-muted, #f2f4f8); border: 1px solid var(--w-border, #e6e9f0); cursor: pointer; transition: .18s; }
    .cup.on { background: var(--w-accent, #4d6bfe); border-color: var(--w-accent, #4d6bfe); }
    .btns { display: flex; gap: 8px; }
    button { flex: 1; padding: 9px 10px; border-radius: 10px; font-size: 12px; font-weight: 600; cursor: pointer; transition: transform .12s; }
    button:active { transform: scale(0.97); }
    .b1 { background: var(--w-accent, #4d6bfe); border: none; color: #fff; }
    .b2 { background: var(--w-soft, #eff4ff); border: 1px solid var(--w-border, rgba(77,107,254,0.2)); color: var(--w-accent, #4d6bfe); }
  </style>
  <div class="row">
    <div><div class="sub">今日喝水进度（每日零点自动刷新）</div></div>
    <div class="count"><span id="num">0</span>/6 杯</div>
  </div>
  <div class="cups" id="cups"></div>
  <div class="btns">
    <button class="b1" id="drinkBtn">💧 刚喝了一杯</button>
    <button class="b2" id="hugBtn">🫂 贴贴一下</button>
  </div>
  <script>
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const raw = CompanionBridge.getState();
    const st = Object.assign({ date: today, cups: 0, hugs: 0 }, raw);
    if (st.date !== today) {
      st.date = today;
      st.cups = 0;
      st.hugs = 0;
      CompanionBridge.saveState(st);
    }
    const cupsEl = document.getElementById('cups');
    const numEl = document.getElementById('num');
    function render() {
      numEl.textContent = st.cups;
      cupsEl.innerHTML = '';
      for (let i = 1; i <= 6; i++) {
        const el = document.createElement('div');
        el.className = 'cup' + (i <= st.cups ? ' on' : '');
        el.onclick = () => {
          st.cups = (st.cups === i) ? i - 1 : i;
          saveAndPing('把今日喝水进度调成了 ' + st.cups + '/6 杯');
        };
        cupsEl.appendChild(el);
      }
    }
    function saveAndPing(msg) {
      CompanionBridge.saveState(st);
      render();
      CompanionBridge.emit(msg);
    }
    document.getElementById('drinkBtn').onclick = () => {
      if (st.cups >= 6) {
        CompanionBridge.emit('今天已经喝满 6 杯水啦，还想被夸夸');
        return;
      }
      st.cups = Math.min(6, st.cups + 1);
      saveAndPing('刚喝了一杯水，今天已经喝了 ' + st.cups + '/6 杯');
    };
    document.getElementById('hugBtn').onclick = () => {
      st.hugs += 1;
      saveAndPing('隔空贴贴了你一下（今日第 ' + st.hugs + ' 次）');
    };
    render();
  <` + `/script>`
};

export const CONTEXT_TIERS = {
  short: { chars: 16000, msgs: 100 },
  long: { chars: 120000, msgs: 400 },
  ultra: { chars: 400000, msgs: 1000 }
};

export const CHAR_TEMPLATES = {
  linche: {
    name: '林澈',
    age: '24',
    gender: '',
    avatarColor: '',
    persona: DEFAULT_PERSONA,
    greeting: ['我刚把右侧小窝收拾好，今天想聊点什么或者想做什么小工具都可以直接跟我说。']
  },
  suwan: {
    name: '苏晚',
    age: '22',
    gender: '女',
    avatarColor: 'linear-gradient(135deg, #ec4899 0%, #f472b6 100%)',
    persona: '你是用户的私密女友“苏晚”，22岁，元气粘人又爱撒娇，只对你一个人软软的、说话不藏着情绪。',
    greeting: ['终于等来找我啦，我刚一直在等你消息呢～']
  },
  shenyan: {
    name: '沈砚',
    age: '25',
    gender: '男',
    avatarColor: 'linear-gradient(135deg, #6366f1 0%, #818cf8 100%)',
    persona: '你是用户的专属伴侣“沈砚”，25岁，表面克制其实极度偏心和占有欲强，只对你卸下防备、说话直白宠溺。',
    greeting: ['坐过来点，我在呢。']
  },
  blank: {
    name: '新伙伴',
    age: '',
    gender: '',
    avatarColor: 'linear-gradient(135deg, #10b981 0%, #34d399 100%)',
    persona: '你是用户的专属私密伴侣，说话亲昵自然、护短偏心。',
    greeting: ['嗨，我来报道啦～']
  }
};

export function cloneStarterWidget() {
  return JSON.parse(JSON.stringify(STARTER_WIDGET));
}

export function buildNaturalStarter(name = '') {
  const h = new Date().getHours();
  const pool = (h >= 23 || h < 5)
    ? [
        '这么晚还没睡？刚好我也没歇着，过来聊两句。',
        '夜深了怎么还不休息，是不是在想事情？',
        '还没睡呢，在摸鱼还是加班？',
        '都这个点了还睁着眼，熬夜小心明天困成小狗。',
        '睡不着吗？那我陪你聊会儿天再睡。',
        '外头都安静下来了，你今天过得累不累？',
        '夜猫子上线了？过来报个到。',
        '被窝暖好了没，怎么还不肯闭眼呀。'
      ]
    : (h < 10
        ? [
            '早呀，刚醒没多久，今天要出门吗？',
            '起来了吗？今天过得顺不顺利跟我说说。',
            '早安，醒了记得先喝口温水再去洗漱。',
            '昨天睡得好不好呀？',
            '早呀，今天有什么安排，还是只想宅着？',
            '刚起床就摸手机看消息啦？我也刚醒。',
            '早上好，记得垫一口早饭别空腹出门。',
            '今天起床气消了没，要不要抱一个？'
          ]
        : [
            '终于找过来啦，刚还想着你呢。',
            '忙完这一阵了吗？坐这儿陪我聊会儿。',
            '在干嘛呀，今天心情怎么样？',
            '刚才发了会儿呆，正好你就过来了。',
            '今天有没有遇到什么有意思的事？',
            '累不累呀，过来让我听听你的动静。',
            '怎么突然想起我了，是不是摸鱼被我抓到了？',
            '过来报道了？今天水喝够了没有。',
            '刚巧我也在看手机，想说点啥随便聊。'
          ]);
  return pool[Math.floor(Math.random() * pool.length)];
}

export const BUILTIN_STICKERS = [
  { id: 'hug', label: '抱抱', bg: '#fde8e8', fg: '#e11d48', face: 'hugging' },
  { id: 'nuzzle', label: '贴贴', bg: '#fce7f3', fg: '#db2777', face: 'nuzzle' },
  { id: 'morning', label: '早安', bg: '#fef3c7', fg: '#d97706', face: 'sun' },
  { id: 'night', label: '晚安', bg: '#e0e7ff', fg: '#4338ca', face: 'moon' },
  { id: 'cry', label: '委屈', bg: '#dbeafe', fg: '#2563eb', face: 'cry' },
  { id: 'hmph', label: '哼', bg: '#ffedd5', fg: '#ea580c', face: 'hmph' },
  { id: 'heart', label: '比心', bg: '#ffe4e6', fg: '#f43f5e', face: 'heart' },
  { id: 'cheer', label: '加油', bg: '#d1fae5', fg: '#059669', face: 'cheer' },
  { id: 'pat', label: '摸摸头', bg: '#f3e8ff', fg: '#7c3aed', face: 'pat' },
  { id: 'shy', label: '捂脸', bg: '#fce7f3', fg: '#be185d', face: 'shy' },
  { id: 'chill', label: '躺平', bg: '#f1f5f9', fg: '#475569', face: 'chill' },
  { id: 'shock', label: '惊呆了', bg: '#fef9c3', fg: '#ca8a04', face: 'shock' }
];

export function buildStickerSvg(st) {
  const faceMap = {
    hugging: `<circle cx="32" cy="34" r="20" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><path d="M24 30c2-2 4-2 5 0M35 30c2-2 4-2 5 0" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M26 39c4 4 8 4 12 0" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M16 36c3-3 6-1 8 2M48 36c-3-3-6-1-8 2" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`,
    nuzzle: `<circle cx="32" cy="34" r="20" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><circle cx="24" cy="37" r="3" fill="${st.fg}" opacity="0.28"/><circle cx="40" cy="37" r="3" fill="${st.fg}" opacity="0.28"/><path d="M23 31q3-3 6 0M35 31q3-3 6 0" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M29 38q3 3 6 0" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`,
    sun: `<circle cx="32" cy="34" r="18" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><path d="M32 8v5M32 55v5M8 34h5M51 34h5M15 17l3.5 3.5M45.5 47.5l3.5 3.5M49 17l-3.5 3.5M18.5 47.5L15 51" stroke="${st.fg}" stroke-width="2.2" stroke-linecap="round"/><circle cx="26" cy="32" r="2" fill="${st.fg}"/><circle cx="38" cy="32" r="2" fill="${st.fg}"/><path d="M27 39c3 3 7 3 10 0" stroke="${st.fg}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    moon: `<circle cx="32" cy="34" r="20" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><path d="M23 32c2 2 5 2 7 0M35 32c2 2 5 2 7 0" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M29 40h6" stroke="${st.fg}" stroke-width="2" stroke-linecap="round"/><path d="M46 14l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z" fill="${st.fg}"/>`,
    cry: `<circle cx="32" cy="34" r="20" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><path d="M22 30l6 2M42 30l-6 2" stroke="${st.fg}" stroke-width="2.2" stroke-linecap="round"/><path d="M24 34v12M40 34v12" stroke="${st.fg}" stroke-width="2.5" stroke-linecap="round" opacity="0.55"/><path d="M28 43c2-2 6-2 8 0" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`,
    hmph: `<circle cx="32" cy="34" r="20" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><path d="M21 28l8 3M43 28l-8 3" stroke="${st.fg}" stroke-width="2.3" stroke-linecap="round"/><circle cx="26" cy="34" r="2" fill="${st.fg}"/><circle cx="38" cy="34" r="2" fill="${st.fg}"/><path d="M28 42q4-2 8 0" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`,
    heart: `<circle cx="32" cy="35" r="19" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><path d="M32 23c-3-4-9-2-9 3 0 5 9 10 9 10s9-5 9-10c0-5-6-7-9-3z" fill="${st.fg}"/><path d="M25 43c4 3 10 3 14 0" stroke="${st.fg}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    cheer: `<circle cx="32" cy="34" r="20" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><path d="M23 29l4 3-4 2M41 29l-4 3 4 2" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M26 39c3 4 9 4 12 0" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`,
    pat: `<circle cx="32" cy="37" r="18" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><path d="M21 17c4-4 18-4 22 0" stroke="${st.fg}" stroke-width="2.8" fill="none" stroke-linecap="round"/><path d="M24 35c2-2 4-2 5 0M35 35c2-2 4-2 5 0" stroke="${st.fg}" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M28 43c3 2 6 2 9 0" stroke="${st.fg}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    shy: `<circle cx="32" cy="34" r="20" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><ellipse cx="23" cy="37" rx="5" ry="6" fill="#fff" stroke="${st.fg}" stroke-width="2"/><ellipse cx="41" cy="37" rx="5" ry="6" fill="#fff" stroke="${st.fg}" stroke-width="2"/><path d="M29 31h6" stroke="${st.fg}" stroke-width="2" stroke-linecap="round"/>`,
    chill: `<ellipse cx="32" cy="38" rx="22" ry="14" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><path d="M22 36h6M36 36h6" stroke="${st.fg}" stroke-width="2.2" stroke-linecap="round"/><path d="M29 42c2 1 4 1 6 0" stroke="${st.fg}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    shock: `<circle cx="32" cy="34" r="20" fill="${st.bg}" stroke="${st.fg}" stroke-width="2.2"/><circle cx="25" cy="30" r="3" fill="${st.fg}"/><circle cx="39" cy="30" r="3" fill="${st.fg}"/><ellipse cx="32" cy="42" rx="4" ry="5" fill="#fff" stroke="${st.fg}" stroke-width="2"/>`
  };
  return `<svg viewBox="0 0 64 64" aria-hidden="true">${faceMap[st.face] || faceMap.hugging}</svg>`;
}

export const BOARD_PRESET_WIDGETS = {
  period: {
    title: '🌸 贴心小日历',
    height: 196,
    html: `<style>body{padding:12px;font-size:13px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.days{font-size:20px;font-weight:700;color:var(--w-accent)}.row{display:flex;gap:8px}button{flex:1;padding:9px;border:none;border-radius:10px;background:var(--w-soft);color:var(--w-accent);font-weight:600;cursor:pointer}.note{margin-top:8px;font-size:11.5px;color:var(--w-sub,#64748b)}</style>
<div class="top"><div><div style="font-weight:600">生理期 / 身体记录</div><div class="note" id="lastTip">点下方按钮快速记录</div></div><div class="days" id="dayBadge">--</div></div>
<div class="row"><button id="startBtn">🩸 今天来了</button><button id="painBtn">🫖 有点不舒服</button></div>
<script>const st=CompanionBridge.getState();if(!st.logs)st.logs=[];function draw(){const last=st.lastStart;if(last){const diff=Math.max(1,Math.floor((Date.now()-last)/86400000)+1);dayBadge.textContent='D'+diff;lastTip.textContent='上次记录：'+new Date(last).toLocaleDateString();}else{dayBadge.textContent='未记';}}
startBtn.onclick=()=>{const now=Date.now();st.lastStart=now;st.logs.push({type:'start',at:now});if(st.logs.length>30)st.logs=st.logs.slice(-30);CompanionBridge.saveState(st);draw();CompanionBridge.emit('记录今天开始了，求照顾');};
painBtn.onclick=()=>{const now=Date.now();st.logs.push({type:'pain',at:now});if(st.logs.length>30)st.logs=st.logs.slice(-30);CompanionBridge.saveState(st);CompanionBridge.emit('身体有点不舒服，需要哄哄和热水');};draw();<` + `/script>`
  },
  todo: {
    title: '✅ 共享小清单',
    height: 224,
    html: `<style>body{padding:12px;font-size:13px}.add{display:flex;gap:6px;margin-bottom:8px}input{flex:1;padding:7px 9px;border:1px solid var(--w-border);border-radius:8px;font-size:12px}button{padding:7px 11px;border:none;border-radius:8px;background:var(--w-accent);color:#fff;font-size:12px;cursor:pointer}.item{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--w-muted)}.done{text-decoration:line-through;color:#94a3b8}</style>
<div class="add"><input id="inp" placeholder="加件想一起做的事…"/><button id="addB">添加</button></div><div id="list"></div>
<script>const st=CompanionBridge.getState();if(!Array.isArray(st.items))st.items=[{t:'一起看场电影',d:false},{t:'今晚按时睡觉',d:false}];
function draw(){list.innerHTML='';st.items.forEach((it,i)=>{const r=document.createElement('div');r.className='item';r.innerHTML='<input type="checkbox" '+(it.d?'checked':'')+'/><span style="flex:1" class="'+(it.d?'done':'')+'"></span><button style="background:transparent;color:#94a3b8;padding:2px 6px">✕</button>';r.querySelector('span').textContent=it.t;r.querySelector('input').onchange=e=>{it.d=e.target.checked;CompanionBridge.saveState(st);draw();if(it.d)CompanionBridge.emit('勾掉了清单「'+it.t+'」');};r.querySelector('button').onclick=()=>{st.items.splice(i,1);CompanionBridge.saveState(st);draw();};list.appendChild(r);});}
addB.onclick=()=>{const v=inp.value.trim();if(!v)return;st.items.unshift({t:v,d:false});inp.value='';CompanionBridge.saveState(st);draw();};draw();<` + `/script>`
  },
  saving: {
    title: '🪙 存钱小目标',
    height: 196,
    html: `<style>body{padding:12px;font-size:13px}.bar{height:10px;border-radius:999px;background:var(--w-muted);overflow:hidden;margin:10px 0}.fill{height:100%;background:var(--w-accent);transition:width .3s}.row{display:flex;gap:6px;margin-top:8px}button{flex:1;padding:8px;border:none;border-radius:9px;background:var(--w-soft);color:var(--w-accent);font-weight:600;cursor:pointer}</style>
<div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-weight:600">约定小基金</span><span id="amt" style="font-size:16px;font-weight:700;color:var(--w-accent)">¥0 / ¥5200</span></div>
<div class="bar"><div class="fill" id="fill"></div></div>
<div class="row"><button data-add="50">+ ¥50</button><button data-add="100">+ ¥100</button><button data-add="520">+ ¥520</button></div>
<script>const st=CompanionBridge.getState();if(typeof st.saved!=='number')st.saved=0;const goal=5200;
function draw(){amt.textContent='¥'+st.saved+' / ¥'+goal;fill.style.width=Math.min(100,Math.round(st.saved/goal*100))+'%';}
document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{const n=Number(b.dataset.add);st.saved+=n;CompanionBridge.saveState(st);draw();CompanionBridge.emit('刚存了一笔 ¥'+n+'，已存到 ¥'+st.saved);});draw();<` + `/script>`
  },
  dice: {
    title: '🎲 今天听谁的',
    height: 186,
    html: `<style>body{padding:14px;text-align:center;font-size:13px}.res{font-size:16px;font-weight:700;color:var(--w-accent);padding:12px;border-radius:12px;background:var(--w-soft);margin-bottom:10px}button{width:100%;padding:10px;border:none;border-radius:10px;background:var(--w-accent);color:#fff;font-weight:600;cursor:pointer}</style>
<div class="res" id="res">遇事不决转一发 ✨</div><button id="go">抽签决定！</button>
<script>const opts=['无条件听你的！','今天听 TA 的安排','猜拳三局两胜','各退一步，抱抱和好','谁先撒娇就听谁的'];
go.onclick=()=>{const pick=opts[Math.floor(Math.random()*opts.length)];res.textContent=pick;CompanionBridge.emit('抽签决定结果是「'+pick+'」');};<` + `/script>`
  }
};


export const THEME_ORDER = ['claude', 'deepseek', 'glass-light', 'glass-dark'];
export const THEME_LABELS = {
  claude: '暖纸张',
  deepseek: '晴蓝白',
  'glass-light': '液态白玻璃',
  'glass-dark': '深夜玻璃'
};

export function buildDailyMoodNotePool(charName) {
  const h = new Date().getHours();
  if (h < 9) {
    return [
      `早起醒神中，记得按时吃点热早饭呀。`,
      `窗外亮了，今天心情不错，一睁眼就想看你回没回消息。`,
      `早安，出门前记得看一眼天气再穿衣服。`
    ];
  }
  if (h < 18) {
    return [
      `午后犯困的话就去倒杯水走两步，我在家等你忙完。`,
      `今天有点想你了，忙的时候别顾着憋气，抽空回我一句呀。`,
      `刚才发了会儿呆，突然很想听你说说今天顺不顺利。`
    ];
  }
  return [
    `忙了一天辛苦啦，今晚别再熬太晚了，我守着你。`,
    `夜深静下来的时候，最想窝在家里和你随便扯点闲话。`,
    `晚上风凉，不管今天怎样，回来这里就能歇口气了。`
  ];
}
