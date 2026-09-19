/* 小小汽车设计师 · 后端代理（Node 零依赖）
 * 作用：1) 托管静态页面 2) 隐藏 API Key 3) 把孩子画的车顶轮廓 + 选项组装成绘图 Prompt
 * 启动：node server.js   （端口 8777，可用 PORT 环境变量改）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8777;
const ROOT = __dirname;

/* ---------- 配置：环境变量优先，其次同目录 config.json ---------- */
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) {}
const ENV = Object.assign({}, fileCfg, process.env);

const CFG = {
  provider: (ENV.PROVIDER || 'mock').toLowerCase(),      // 默认 mock：不配 Key 也能玩
  // 腾讯混元生图
  txId: ENV.TENCENT_SECRET_ID || '',
  txKey: ENV.TENCENT_SECRET_KEY || '',
  txRegion: ENV.TENCENT_REGION || '',
  txHost: ENV.TENCENT_HOST || 'hunyuan.tencentcloudapi.com',
  txService: ENV.TENCENT_SERVICE || 'hunyuan',
  txVersion: ENV.TENCENT_VERSION || '2023-09-01',
  txSubmit: ENV.TENCENT_SUBMIT_ACTION || 'SubmitHunyuanImageJob',
  txQuery: ENV.TENCENT_QUERY_ACTION || 'QueryHunyuanImageJob',
  txStyle: ENV.TENCENT_STYLE || '',
  // 火山方舟（豆包 Seedream）
  arkBase: ENV.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
  arkKey: ENV.ARK_API_KEY || '',
  arkModel: ENV.ARK_IMAGE_MODEL || 'doubao-seedream-5.0-lite',
  arkSize: ENV.ARK_IMAGE_SIZE || '2K',
  arkUseSketch: String(ENV.ARK_USE_SKETCH || 'true').toLowerCase() === 'true',
  // OpenAI 兼容（OpenAI / 任意兼容网关）
  oaBase: ENV.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  oaKey: ENV.OPENAI_API_KEY || '',
  oaModel: ENV.OPENAI_IMAGE_MODEL || 'gpt-image-1',
  size: ENV.IMAGE_SIZE || '1024x1024',
  timeoutMs: Number(ENV.TIMEOUT_MS || 180000),
};

/* ---------- Prompt 组装 ---------- */
const SAFE_NEG = '文字, 水印, logo, 二维码, 品牌商标, 血腥, 暴力, 恐怖, 成人内容, 畸形, 残缺轮胎, 模糊, 低质量, 多人, '
  + '纯白背景, 纯色背景, 空白背景, 抠图感, 贴纸感, 简笔画, 涂鸦, Q版, chibi, 低龄卡通, 三头身, '
  + '深色背景, 暗黑背景, 黑色背景, 昏暗光线, 夜晚暗调, 高对比暗色, 正侧面平视图, 正交侧视图, '
  + '普通量产街车, 现实车型复刻, 平淡无趣, 缺乏创意, 结构混乱, 零件胡乱堆砌, 怪物造型';

/* 每种风格的"质感 + 场景背景"设定（背景是重点：不再出白底抠图） */
const STYLE_ART = {
  cyber: {
    look: 'cyberpunk concept car, glowing neon light strips on the body, bright daylight cyber city, clean high detail render',
    bg: '明亮清爽的未来城市街道，浅色天空与玻璃幕墙高楼，路面微湿带淡淡霓虹反光，整体色调明亮干净',
    im: '会呼吸的脉动霓虹光带、透明引擎盖里可见的发光能量核心、悬浮的全息尾翼、车轮内嵌发光环',
  },
  retro: {
    look: '1950s vintage classic car with chrome trim, bright sunny afternoon, pastel film photography look',
    bg: '晴朗午后的复古公路，明亮的蓝天白云，路边有棕榈树和老式加油站，暖阳洒在浅色路面上',
    im: '复古火箭尾鳍、圆润饱满的流线车身、镀铬装饰与柔和的未来光效混搭，像老电影里的梦幻车',
  },
  anime: {
    look: 'japanese anime style, cel shading, clean lineart, bright pastel colors, light anime background art',
    bg: '明亮的日式动漫街道，浅蓝天空与淡淡粉色樱花，米白色墙面与浅色水彩质感的背景',
    im: '像有生命一样的车——车灯像会笑的大眼睛、前脸有表情、车顶飘着小星星与光点、车尾有小小的能量尾迹',
  },
  future: {
    look: 'sleek futuristic concept car, metallic and glass surfaces, bright showroom product render, soft studio light',
    bg: '明亮通透的白色高科技展厅，浅灰反光地面与柔和灯环，大面积自然光，背景简洁干净',
    im: '无轮毂的磁悬浮轮、一体化无缝玻璃座舱、车身随光线渐变的流光曲面、车底有柔和的光垫托起车身',
  },
  sport: {
    look: 'professional motorsport photography, racing livery, dynamic three-quarter front low-angle shot, bright daylight',
    bg: '阳光明媚的赛道维修区，浅色看台与蓝天，方格旗点缀，地面干净明亮',
    im: '可变形的主动尾翼、喷薄的能量尾焰、轮毂带光流拖影、车身贴地飞驰的动感姿态',
  },
  minecraft: {
    look: 'Minecraft style, voxel blocks, cubic low-poly shapes, blocky pixel texture, bright daytime grass biome',
    bg: '明亮的方块世界白天场景，浅绿草方块地面、蓝天和方块白云，光线明亮通透',
    im: '由发光方块拼成的引擎与推进器、可以拼装拆卸的方块车身、车顶有方块小装置、方块轮子里透出光',
  },
};

/* 脑洞等级：孩子可以自己选择"要多大胆" */
const IMAGINE_LEVEL = {
  calm: '想象力要收敛：造型漂亮、比例协调、细节精致，只加入少量未来感元素，接近可以量产的概念车。',
  bold: '想象力要明显：这是孩子梦想中的座驾，不是马路上的普通量产车——请加入让人"哇"出声的创意设计，'
      + '造型夸张但不混乱，结构要自洽、看起来真的能跑。',
  wild: '想象力放飞到极致：允许悬浮、透明、变形、仿生、能量化、模块化等超现实设定，越超出想象越好；'
      + '但整车仍需是一个清晰可辨的汽车形态，结构自洽、有美感，不要变成怪物或零件乱堆。',
};

function imagineText(b) {
  const id = (b.imagineId || '').toLowerCase();
  if (IMAGINE_LEVEL[id]) return IMAGINE_LEVEL[id];
  const n = b.imagineName || '';
  if (n.indexOf('狂想') >= 0) return IMAGINE_LEVEL.wild;
  if (n.indexOf('稳妥') >= 0) return IMAGINE_LEVEL.calm;
  return IMAGINE_LEVEL.bold;
}

/* 配件中英对照，帮助模型准确画出 */
const EXTRA_EN = {
  '炫酷尾翼': 'rear spoiler', '车顶行李架': 'roof rack', '超大越野轮': 'oversized off-road wheels',
  '霓虹灯带': 'neon underglow light strip', '星星贴纸': 'star decals', '火焰涂鸦': 'flame decal paint',
  '雷达天线': 'roof antenna and sensor radar', '车顶探照灯': 'roof spotlights', '装甲护杠': 'heavy armored bumper',
  '全景天窗': 'panoramic glass sunroof', '火箭推进器': 'rocket booster', '像素方块': 'pixel voxel cube blocks',
  '祥云纹饰': 'auspicious cloud pattern', '闪电拉花': 'lightning bolt livery', '赛车条纹': 'racing stripes',
};

function styleArt(b) {
  const id = (b.styleId || '').toLowerCase();
  if (STYLE_ART[id]) return STYLE_ART[id];
  const kw = { cyber: ['赛博'], retro: ['复古', '经典'], anime: ['卡通', '动漫'], future: ['未来'], sport: ['极速', '运动', '竞速', '赛道'], minecraft: ['我的世界', '像素'] };
  const byName = Object.keys(STYLE_ART).find(k => kw[k].some(w => (b.styleName || '').indexOf(w) >= 0));
  return byName ? STYLE_ART[byName] : STYLE_ART.future;
}

/* 线稿参考说明：孩子的手绘图会作为 image 一起送进模型，提示词负责解释这张图是什么 */
const SKETCH_HINT = '我已附上一张线稿参考图：白底上黑色粗线勾出的闭合形状，就是小朋友亲手画的车身侧视轮廓。'
  + '其中上方那条起伏的线是车顶线，底边是底盘，两个圆是前后车轮，灰色横线是地面。'
  + '请严格沿用这个轮廓的形状、比例和走势（车顶高低、车头车尾的倾斜都要保持一致），但展示角度改用斜前方 45°，把它渲染成完整、精致的整车，不要把线稿的生硬感带进成品。';

function buildPrompt(b, useSketch) {
  const art = styleArt(b);
  const extras = (b.extras && b.extras.length)
    ? ('配件与装饰：' + b.extras.join('、') + '（' + b.extras.map(x => EXTRA_EN[x] || '').filter(Boolean).join(', ') + '）。')
    : '';
  const zh = [
    '一张高质量的汽车设计渲染图（产品级质感，写实光影与材质）。',
    '车型：' + b.carType + '（' + (b.carTypeEn || '') + '）。',
    '车身主色：' + b.colorName + '(' + b.colorHex + ')，' + b.styleName + '风格。',
    useSketch ? SKETCH_HINT : ('车身侧视轮廓：' + (b.outlineText || '') + '。'),
    extras,
    '创意方向（这是孩子梦想中的座驾，不是马路上的普通量产车）：' + imagineText(b),
    '本风格的想象元素（至少体现其中两项，可以自己再发挥）：' + art.im + '。',
    '场景背景：' + art.bg + '。',
    '展示角度：斜前方 45° 三透视角（three-quarter front view）——车身斜着朝向观众，车头转向画面外侧，'
    + '能同时看到车头正面和一侧车身，透视立体感强，不要拍成完全正侧面的平视图。',
    '画面要求：整车完整入镜，四轮着地，构图居中，低机位稍仰视让车更有气势；背景清晰完整、色调明亮浅淡'
    + '（浅色天空／浅灰或米白的环境，不要纯白底、不要抠图感、不要深色暗背景），柔和均匀的自然光，细节丰富。',
    '整体观感要精致、像真实汽车广告渲染图，但色彩明快、适合孩子欣赏；画面中不要出现任何文字、字母与品牌 logo。',
    '风格关键词：' + art.look,
  ].join('');
  return zh;
}

/* ---------- 腾讯云 TC3 签名（零依赖实现） ---------- */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function tc3Headers(host, service, action, version, payload, region) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = 'content-type:application/json\nhost:' + host + '\n';
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(payload)].join('\n');
  const algorithm = 'TC3-HMAC-SHA256';
  const scope = date + '/' + service + '/tc3_request';
  const stringToSign = [algorithm, timestamp, scope, sha256(canonicalRequest)].join('\n');
  const kDate = crypto.createHmac('sha256', 'TC3' + CFG.txKey).update(date).digest();
  const kService = crypto.createHmac('sha256', kDate).update(service).digest();
  const kSign = crypto.createHmac('sha256', kService).update('tc3_request').digest();
  const sig = crypto.createHmac('sha256', kSign).update(stringToSign).digest('hex');
  return {
    'Content-Type': 'application/json',
    'Host': host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(timestamp),
    ...(region ? { 'X-TC-Region': region } : {}),
    'Authorization': algorithm + ' Credential=' + CFG.txId + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + sig,
  };
}

async function txCall(action, body) {
  const payload = JSON.stringify(body);
  const r = await fetch('https://' + CFG.txHost, {
    method: 'POST',
    headers: tc3Headers(CFG.txHost, CFG.txService, action, CFG.txVersion, payload, CFG.txRegion),
    body: payload,
  });
  const j = await r.json();
  if (j.Response && j.Response.Error) throw new Error('[tencent] ' + j.Response.Error.Code + ': ' + j.Response.Error.Message);
  return j.Response || {};
}

async function genTencent(prompt) {
  const body = { Prompt: prompt, NegativePrompt: SAFE_NEG, Num: 1 };
  if (CFG.txStyle) body.Style = CFG.txStyle;
  const sub = await txCall(CFG.txSubmit, body);
  const jobId = sub.JobId;
  if (!jobId) throw new Error('[tencent] 未返回 JobId：' + JSON.stringify(sub));
  const t0 = Date.now();
  while (Date.now() - t0 < CFG.timeoutMs) {
    await new Promise(r => setTimeout(r, 2500));
    const q = await txCall(CFG.txQuery, { JobId: jobId });
    if (q.JobStatusCode === '5:DONE' || q.JobStatusMsg === 'DONE' || (q.ResultImage && q.ResultImage.length)) {
      const item = (q.ResultImage || [])[0] || {};
      if (item.Image) return 'data:image/png;base64,' + item.Image;
      if (item.Url) return await urlToDataUrl(item.Url);
      throw new Error('[tencent] 任务完成但没有图片：' + JSON.stringify(q).slice(0, 300));
    }
    if (q.JobStatusCode && /FAIL|ERROR/.test(q.JobStatusCode)) {
      throw new Error('[tencent] 生成失败：' + (q.JobErrorMsg || q.JobStatusCode));
    }
  }
  throw new Error('[tencent] 生成超时');
}

/* ---------- OpenAI 兼容协议（OpenAI / 火山方舟 / 任意网关） ---------- */
async function genCompat(prompt, opt) {
  const body = Object.assign({ model: opt.model, prompt: prompt, size: opt.size, n: 1 }, opt.extra || {});
  const r = await fetch(opt.base.replace(/\/$/, '') + '/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + opt.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CFG.timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    throw new Error('[' + opt.name + '] ' + (j.error ? (j.error.message || JSON.stringify(j.error)) : ('HTTP ' + r.status)));
  }
  const d = (j.data || [])[0] || {};
  if (d.b64_json) return 'data:image/png;base64,' + d.b64_json;
  if (d.url) return await urlToDataUrl(d.url);
  throw new Error('[' + opt.name + '] 返回里没有图片：' + JSON.stringify(j).slice(0, 300));
}

/* ---------- 使用者自带的模型配置（每次请求带来，不写进磁盘） ----------
 * 前端「⚙ 设置」里填的 provider / apiKey / model / baseUrl 会放在请求体的 cfg 字段，
 * 后端只在本次请求内使用，绝不落盘、不打日志。
 */
const PROVIDER_PRESET = {
  ark:     { base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-260128', size: '2K' },
  openai:  { base: 'https://api.openai.com/v1',                model: 'gpt-image-1',                 size: '1024x1024' },
  tencent: { base: '',                                          model: '',                            size: '1024x1024' },
};
function pick(base, v) { return (v === undefined || v === null || v === '') ? base : v; }
function resolveCfg(c) {
  c = c || {};
  const p = String(c.provider || CFG.provider || 'mock').toLowerCase();
  const preset = PROVIDER_PRESET[p] || {};
  return {
    provider: p,
    apiKey: String(c.apiKey || '').trim(),
    secretId: String(c.secretId || '').trim(),
    secretKey: String(c.secretKey || '').trim(),
    base: pick(preset.base || CFG.arkBase, c.baseUrl),
    model: pick(preset.model || CFG.arkModel, c.model),
    size: pick(preset.size || CFG.arkSize, c.size),
  };
}

/* 火山方舟 · 豆包 Seedream
 * 实测：image 参数必须是 data URL（"data:image/png;base64,..."），裸 base64 会报 InvalidParameter */
async function genArk(prompt, sketch, c) {
  const extra = { response_format: 'url', watermark: false };
  // 把孩子画的线稿作为参考图送进去（出图才会真正贴合他画的轮廓）
  if (CFG.arkUseSketch && sketch && /^data:image\//.test(sketch)) extra.image = [sketch];
  return genCompat(prompt, {
    name: 'ark', base: c.base, key: c.apiKey || CFG.arkKey,
    model: c.model, size: c.size, extra,
  });
}

async function genOpenAI(prompt, c) {
  return genCompat(prompt, {
    name: 'openai', base: c.base, key: c.apiKey || CFG.oaKey, model: c.model, size: c.size,
  });
}

/* 方舟返回的是临时 URL，需要下载回来给前端；偶发网络抖动，重试 3 次 */
async function urlToDataUrl(u) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || 'image/png';
      return 'data:' + ct + ';base64,' + buf.toString('base64');
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw new Error('下载生成结果失败：' + String(last && last.message || last));
}

/* ---------- 路由 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const send = (code, obj, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/api/health') {
    return send(200, { ok: true, provider: CFG.provider, mode: CFG.provider === 'mock' ? '本地渲染（未接模型）' : '已接模型', size: CFG.size });
  }

  if (req.method === 'POST' && req.url === '/api/generate') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const b = JSON.parse(body);
        const c = resolveCfg(b.cfg);
        const useSketch = !!(CFG.arkUseSketch && b.sketch && /^data:image\//.test(b.sketch));
        const prompt = buildPrompt(b, useSketch);
        if (c.provider === 'mock') {
          return send(200, { ok: false, error: '未配置模型：请在页面右上角「⚙ 设置」里填自己的 API Key', prompt, sketchUsed: false });
        }
        if (c.provider !== 'tencent' && !c.apiKey) {
          return send(200, { ok: false, error: '缺少 API Key：请在页面右上角「⚙ 设置」里填写', prompt, sketchUsed: false });
        }
        let image, sketchUsed = false;
        if (c.provider === 'tencent') {
          const savedId = CFG.txId, savedKey = CFG.txKey;
          CFG.txId = c.secretId || savedId; CFG.txKey = c.secretKey || savedKey;
          try { image = await genTencent(prompt); } finally { CFG.txId = savedId; CFG.txKey = savedKey; }
        }
        else if (c.provider === 'openai') image = await genOpenAI(prompt, c);
        else if (c.provider === 'ark') {
          if (useSketch) {
            try {
              image = await genArk(prompt, b.sketch, c);
              sketchUsed = true;
            } catch (e) {
              // 带线稿失败（接口/参数不兼容）→ 自动退回纯文字描述，不让孩子白等
              console.log('[ark] 带线稿生成失败，退回纯文字');
              image = await genArk(buildPrompt(b, false), null, c);
            }
          } else {
            image = await genArk(prompt, b.sketch, c);
          }
        }
        else throw new Error('未知 provider: ' + c.provider);
        return send(200, { ok: true, image, prompt, sketchUsed,
          provider: c.provider === 'ark' ? ('ark/' + c.model) : (c.provider + '/' + c.model) });
      } catch (e) {
        return send(200, { ok: false, error: String(e.message || e), prompt: '' });
      }
    });
    return;
  }

  // 静态文件
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, 'Not Found', 'text/plain; charset=utf-8');
  return send(200, fs.readFileSync(f), MIME[path.extname(f).toLowerCase()] || 'application/octet-stream');
});

server.listen(PORT, () => {
  console.log('🚗 小小汽车设计师已启动： http://localhost:' + PORT);
  console.log('   provider = ' + CFG.provider);
  if (CFG.provider === 'mock') console.log('   （未配置模型 Key，页面会自动使用本地渲染模式，孩子照样能玩）');
});
