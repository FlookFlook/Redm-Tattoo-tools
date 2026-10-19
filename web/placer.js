/* =====================================================================
   Tattoo Placer — วางลายบนภาพ UV ของผิวท่อนบน (bodies_upper) และขา (bodies_lower)
   พื้นที่ 2D แสดงภาพ UV 512 ของชิ้นที่เลือก (ท่อนบน / ขา) ส่งออกได้ 512 / 1024 / 2048

   วิธีวาง (L.place):
     stick / flat / view / wrap — "บนตัว" body.js วางรูปลงตัว 3D แล้วอบกลับเป็นภาพ UV ลายต่อข้ามรอยต่อเอง
                   (L.x, L.y) = จุดกลางบนภาพของชิ้น L.part
     uv          — วางบนภาพ UV ของชิ้น L.part ตรง ๆ ขอบซ้าย-ขวาของภาพห่อถึงกัน
                   (วาดเลเยอร์ซ้ำที่ x ± 512 / y ± 512 ตามที่เปิดห่อไว้)
   ยางลบ: L.erase = canvas ขนาดเท่ารูป (ส่วนที่ลบ) ติดไปกับเลเยอร์เวลาย้าย / หมุน / ยืด
   ===================================================================== */
'use strict';

const SIZE = 512;              // ภาพที่ใช้แก้ไข/แสดงผล (ส่งออกขยายเป็น 1024 / 2048 ได้)
const PAPER = '#ecebe6';
const MAX_SRC = 1024;          // รูปที่ใหญ่กว่านี้ย่อลงตอนโหลด
const PART_NAME = { upper: 'ท่อนบน', lower: 'ขา' };
const PLACE_NAME = { stick: 'ติดตามผิว', flat: 'ฉายตรง', view: 'ฉายจากกล้อง', wrap: 'ห่อรอบ' };
const DEFAULT_PLACE = 'stick';

const $ = (id) => document.getElementById(id);

const S = {
    layers: [],                // ล่าง → บน
    sel: null,
    wrapX: true,
    wrapY: false,
    tile: true,
    grid: true,
    zoom: 'fit',
    refAll: false,
    refPick: '',
    refOpacity: 0.35,
    gender: 'male',            // โมเดลที่ใช้ดู 3D / ไกด์ชิ้นผิว
    uvGuide: true,
    uvPart: 'upper',           // ภาพ UV ที่แสดงในพื้นที่ 2D
    tool: 'move',              // move / erase / restore
    shot: null,                // รูปในร้านที่ใส่เอง { src, img, zoom, ox, oy } — ไม่มี = ครอปจากลาย
    shotGray: false,           // รูปในร้านเป็นขาวดำ
    inkThick: 0,               // หนาเส้นเพิ่ม (จุดบนผิวในเกม 512)
    inkSharp: 0,               // คมขึ้น 0..1
    thinWarn: false,           // เน้นสีเส้นที่บางเกินไป
};

const brush = { size: 1.5, soft: 50 };   // ขนาดแปรง (ซม. บนตัว) · ขอบนุ่ม %

let nextId = 1;
const refs = {};               // ชื่อ → Image

// ───────────────────────────────────────────── utils ─────────────

function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.className = isError ? 'error' : '';
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.add('hidden'), 2600);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mod = (v, m) => ((v % m) + m) % m;

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

function download(name, blobOrUrl) {
    const a = document.createElement('a');
    const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function offsets() {
    const xs = S.wrapX ? [-SIZE, 0, SIZE] : [0];
    const ys = S.wrapY ? [-SIZE, 0, SIZE] : [0];
    const out = [];
    for (const ox of xs) for (const oy of ys) out.push([ox, oy]);
    return out;
}

function canvasOf(w, h = w) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
}

const partOf = (L) => (L.part === 'lower' ? 'lower' : 'upper');

/** ลายนี้ฉายลงตัว 3D (body.js อบเป็นภาพให้) ไม่ใช่วางบนภาพ UV ตรง ๆ */
function onBody(L) {
    return !!(window.BodyView && L.place && L.place !== 'uv');
}

// ───────────────────────────────────────────── layers ────────────

/** แปลงรูปต้นฉบับเป็นหน้ากากหมึกตามโหมด/ค่าที่ตั้ง (L.base) แล้วหักส่วนที่ลบ (L.mask)
 *  หมึกเดียว = สีดำ + alpha (ร้านย้อมสีหมึกได้) · ลายสี = สีจากรูป + alpha */
function rebuildMask(L) {
    const c = L.base || (L.base = document.createElement('canvas'));
    c.width = L.w;
    c.height = L.h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, L.w, L.h);
    ctx.drawImage(L.img, 0, 0, L.w, L.h);
    const im = ctx.getImageData(0, 0, L.w, L.h);
    const d = im.data;
    const t = L.threshold / 100;
    const g = L.gain / 100;
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        let v;
        if (L.mode === 'dark') {
            // หมึกเดียว: ยิ่งเข้มยิ่งเป็นหมึก · ลายสี: ยิ่งห่างจากสีขาวยิ่งเป็นหมึก (สีสดก็นับ)
            const ink = L.color
                ? (255 - Math.min(d[i], d[i + 1], d[i + 2])) / 255
                : 1 - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
            v = (L.invert ? 1 - ink : ink) * a;
        } else {
            v = L.invert ? 1 - a : a;
        }
        if (t > 0) v = (v - t) / (1 - t);
        v = clamp(v * g, 0, 1);
        if (!L.color) d[i] = d[i + 1] = d[i + 2] = 0;
        d[i + 3] = Math.round(v * 255);
    }
    ctx.putImageData(im, 0, 0);
    applyErase(L);
}

/** หน้ากากที่ใช้จริง = หน้ากากหมึก − ส่วนที่ยางลบลบไป */
function applyErase(L) {
    const c = L.mask || (L.mask = document.createElement('canvas'));
    if (c.width !== L.w || c.height !== L.h) { c.width = L.w; c.height = L.h; }
    const ctx = c.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(L.base, 0, 0);
    if (L.erase) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(L.erase, 0, 0);
    }
    ctx.globalCompositeOperation = 'source-over';
    L.thumb = null;
    L.maskData = null;         // body.js อ่านใหม่ตอนคลิกบนตัว 3D
    L.maskVer = (L.maskVer || 0) + 1;
}

function layerThumb(L) {
    if (!L.thumb) {
        const k = 84 / Math.max(L.w, L.h);
        const c = canvasOf(Math.max(1, Math.round(L.w * k)), Math.max(1, Math.round(L.h * k)));
        c.getContext('2d').drawImage(L.mask, 0, 0, c.width, c.height);
        L.thumb = c.toDataURL();
    }
    return L.thumb;
}

/** รูปมีสีสดพอจะเป็นลายสีไหม (เดาค่าเริ่มต้นของ "ลายสี") */
function looksColorful(d) {
    let solid = 0, vivid = 0;
    for (let i = 0; i < d.length; i += 16) {
        if (d[i + 3] < 128) continue;
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx > 240 && mn > 240) continue;                 // พื้นขาว
        solid++;
        if (mx - mn > 60) vivid++;
    }
    return solid > 0 && vivid / solid > 0.15;
}

async function addLayer(src, opts = {}) {
    let img = await loadImage(src);
    let w = img.naturalWidth, h = img.naturalHeight;

    // ย่อรูปใหญ่ — เก็บเป็น data URL ใหม่ (ใช้บันทึกโปรเจกต์ด้วย)
    if (Math.max(w, h) > MAX_SRC) {
        const k = MAX_SRC / Math.max(w, h);
        const c = canvasOf(Math.round(w * k), Math.round(h * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        src = c.toDataURL('image/png');
        img = await loadImage(src);
        w = c.width; h = c.height;
    }

    // โหมดอัตโนมัติ: มีส่วนโปร่งใส = PNG พื้นใส / ไม่มีเลย = หมึกบนพื้นขาว · รูปสีสด = ลายสี
    let mode = opts.mode, color = opts.color;
    if (!mode || color === undefined) {
        const c = canvasOf(w, h);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, w, h).data;
        if (!mode) {
            let transparent = 0;
            for (let i = 3; i < d.length; i += 16) if (d[i] < 250) transparent++;
            mode = transparent > 0 ? 'alpha' : 'dark';
        }
        if (color === undefined) color = looksColorful(d);
    }

    const L = Object.assign({
        id: nextId++,
        name: 'ลาย ' + (S.layers.length + 1),
        src, img, w, h,
        x: SIZE / 2, y: SIZE / 2, part: 'upper',
        // ให้รูปกว้างราว 1/4 ของภาพตอนเพิ่มครั้งแรก
        scale: Math.min(1, (SIZE * 0.25) / Math.max(w, h)),
        sx: 1, sy: 1,                                       // ยืดกว้าง / สูง (คูณกับ scale)
        rot: 0, flipX: false, flipY: false,
        threshold: mode === 'dark' ? 15 : 0, gain: 100, invert: false,
        visible: true,
        place: window.BodyView ? DEFAULT_PLACE : 'uv',
        erase: null,
        poses: {},                                          // ตำแหน่งของแต่ละเพศ (body.js)
    }, opts, { img, w, h, src, mode, color });
    if (L.place === 'view' && !L.view && window.BodyView) L.view = BodyView.cameraFrame();
    if (!window.BodyView) L.place = 'uv';
    if (onBody(L)) {
        if (opts.x === undefined) Object.assign(L, BodyView.defaultAnchor());
        if (opts.scale === undefined) L.scale = BodyView.defaultScale(L);
    }

    if (!opts.noHistory) checkpoint();
    delete L.noHistory;
    rebuildMask(L);
    S.layers.push(L);
    S.sel = L;
    refreshAll();
    return L;
}

function selected() { return S.sel && S.layers.includes(S.sel) ? S.sel : null; }

function removeLayer(L) {
    checkpoint();
    S.layers = S.layers.filter((x) => x !== L);
    if (S.sel === L) S.sel = S.layers[S.layers.length - 1] || null;
    refreshAll();
}

function duplicate(L, mirror) {
    checkpoint();
    const copy = Object.assign({}, L, {
        id: nextId++, name: L.name + (mirror ? ' (อีกข้าง)' : ' (สำเนา)'),
        mask: null, base: null, thumb: null, bakes: null, mip: null, maskData: null, poses: {},
        erase: L.erase ? cloneCanvas(L.erase) : null,
    });
    if (mirror) {
        copy.flipX = !L.flipX;
        copy.rot = -L.rot;
        if (L.view) copy.view = { n: [-L.view.n[0], L.view.n[1], L.view.n[2]], up: [-L.view.up[0], L.view.up[1], L.view.up[2]] };
        // ลายติดบนตัว: จุดเดียวกันบนตัวอีกฝั่ง / ลายบนภาพ: สะท้อนกลางภาพ
        const other = onBody(L) && BodyView.mirrorAnchor(L);
        if (other) Object.assign(copy, other);
        else copy.x = mod(SIZE - L.x, SIZE);
    } else {
        copy.x = L.x + 16;
        copy.y = L.y + 16;
        if (S.wrapX) copy.x = mod(copy.x, SIZE);
        if (S.wrapY) copy.y = mod(copy.y, SIZE);
    }
    rebuildMask(copy);
    S.layers.splice(S.layers.indexOf(L) + 1, 0, copy);
    S.sel = copy;
    refreshAll();
}

function cloneCanvas(src) {
    const c = canvasOf(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
}

function drawLayer(ctx, L, ox, oy) {
    ctx.save();
    ctx.translate(L.x + ox, L.y + oy);
    ctx.rotate(L.rot * Math.PI / 180);
    ctx.scale(L.scale * L.sx * (L.flipX ? -1 : 1), L.scale * L.sy * (L.flipY ? -1 : 1));
    ctx.drawImage(L.mask, -L.w / 2, -L.h / 2);
    ctx.restore();
}

/** ภาพลายของชิ้นนั้นทั้งภาพ (ทุกเลเยอร์) — ตัวเดียวกับที่ส่งออก */
const composedParts = {};

/** ทำงานกับเลเยอร์ในท่าของเพศ g (ไม่มีโมเดล = เพศเดียว) */
function inGender(L, g, fn) {
    return window.BodyView && g && g !== S.gender ? BodyView.inGender(L, g, fn) : fn();
}

// ───────────────────────────────────────────── ความคมในเกม ───────
// เกมวาดลายรวมลงภาพผิวที่ทั้งลำตัว + แขนมีแค่ 512x512 (ส่งออกใหญ่กว่านี้ก็ถูกย่อลงมา)
// → หนาเส้น / คมขึ้น ทำกับภาพลายก่อนส่งออก (เห็นในพรีวิวด้วย) · เตือนเส้นบาง วัดที่ 512

const GAME_RES = 512;

/** หนาเส้น: ขยายหมึกออก r จุด (alpha สูงสุดรอบ ๆ — สีเอาจากจุดที่เข้มที่สุด) */
function dilateInk(d, n, r) {
    const N = n * n, orig = d.slice();
    const a1 = new Uint8Array(N), s1 = new Int32Array(N);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            let best = -1, bi = 0;
            for (let k = Math.max(0, x - r), e = Math.min(n - 1, x + r); k <= e; k++) {
                const j = y * n + k, v = orig[j * 4 + 3];
                if (v > best) { best = v; bi = j; }
            }
            a1[y * n + x] = best;
            s1[y * n + x] = bi;
        }
    }
    for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
            let best = -1, bi = 0;
            for (let k = Math.max(0, y - r), e = Math.min(n - 1, y + r); k <= e; k++) {
                const j = k * n + x;
                if (a1[j] > best) { best = a1[j]; bi = s1[j]; }
            }
            const i = (y * n + x) * 4;
            if (best > orig[i + 3]) {
                d[i] = orig[bi * 4]; d[i + 1] = orig[bi * 4 + 1]; d[i + 2] = orig[bi * 4 + 2]; d[i + 3] = best;
            }
        }
    }
}

/** คมขึ้น: unsharp mask ทั้ง alpha และสี (ไม่ทำให้เงาไล่ระดับกลายเป็นขั้น) */
function sharpenInk(d, n, amount, r) {
    const k = amount * 1.6, src = d.slice();
    const blur = new Float32Array(n * n * 4), tmp = new Float32Array(n * n * 4);
    const w = 2 * r + 1;
    const at = (v) => (v < 0 ? 0 : v >= n ? n - 1 : v);
    // กล่องเบลอแยกแกน แบบผลรวมเลื่อนหน้าต่าง (เร็วพอใช้ตอนลากลาย)
    for (let y = 0; y < n; y++) {
        const row = y * n;
        for (let c = 0; c < 4; c++) {
            let s = 0;
            for (let q = -r; q <= r; q++) s += src[(row + at(q)) * 4 + c];
            for (let x = 0; x < n; x++) {
                tmp[(row + x) * 4 + c] = s / w;
                s += src[(row + at(x + r + 1)) * 4 + c] - src[(row + at(x - r)) * 4 + c];
            }
        }
    }
    for (let x = 0; x < n; x++) {
        for (let c = 0; c < 4; c++) {
            let s = 0;
            for (let q = -r; q <= r; q++) s += tmp[(at(q) * n + x) * 4 + c];
            for (let y = 0; y < n; y++) {
                blur[(y * n + x) * 4 + c] = s / w;
                s += tmp[(at(y + r + 1) * n + x) * 4 + c] - tmp[(at(y - r) * n + x) * 4 + c];
            }
        }
    }
    for (let i = 0; i < d.length; i += 4) {
        if (!src[i + 3] && !blur[i + 3]) continue;
        for (let c = 0; c < 4; c++) d[i + c] = src[i + c] + k * (src[i + c] - blur[i + c]);
    }
}

/** ใช้หนาเส้น / คมขึ้นกับภาพลายทั้งแผ่น (ขนาด size) */
function inkPost(ctx, size) {
    if (!S.inkThick && !S.inkSharp) return;
    const im = ctx.getImageData(0, 0, size, size);
    const scale = size / GAME_RES;
    if (S.inkThick) dilateInk(im.data, size, Math.max(1, Math.round(S.inkThick * scale)));
    // คมขึ้นหนักกว่า — ข้ามระหว่างลากลาย / ลบ (ปล่อยเมาส์แล้ววาดใหม่ครบ)
    const live = drag || (window.BodyView && BodyView.busy());
    if (S.inkSharp && !live) sharpenInk(im.data, size, S.inkSharp, Math.max(1, Math.round(scale)));
    ctx.putImageData(im, 0, 0);
}

// เส้นบาง: เปิดภาพ (erode แล้ว dilate) ด้วยกรอบ 2x2 / 3x3 — ส่วนที่หายไป = เส้นกว้าง ≤ 1 / 2 จุดบนผิว 512
const thinParts = {};          // เพศ:ส่วน → canvas สีเตือน
const thinStats = {};          // เพศ:ส่วน → { ink, t1, t2 }

function thinCheck(key, data, n) {
    const N = n * n, ink = new Uint8Array(N);
    let inkCount = 0;
    for (let i = 0; i < N; i++) if (data[i * 4 + 3] >= 96) { ink[i] = 1; inkCount++; }
    const open = (k) => {
        const er = new Uint8Array(N), out = new Uint8Array(N);
        for (let y = 0; y + k <= n; y++) {
            for (let x = 0; x + k <= n; x++) {
                let all = 1;
                for (let dy = 0; dy < k && all; dy++) for (let dx = 0; dx < k; dx++) if (!ink[(y + dy) * n + x + dx]) { all = 0; break; }
                er[y * n + x] = all;
            }
        }
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                if (!er[y * n + x]) continue;
                for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) out[(y + dy) * n + x + dx] = 1;
            }
        }
        return out;
    };
    const o2 = open(2), o3 = open(3);
    const c = thinParts[key] || (thinParts[key] = canvasOf(n));
    const ctx = c.getContext('2d');
    const im = ctx.createImageData(n, n);
    let t1 = 0, t2 = 0;
    for (let i = 0; i < N; i++) {
        if (!ink[i]) continue;
        const q = i * 4;
        if (!o2[i]) { im.data.set([235, 20, 60, 230], q); t1++; }
        else if (!o3[i]) { im.data.set([255, 150, 0, 210], q); t2++; }
    }
    ctx.putImageData(im, 0, 0);
    thinStats[key] = { ink: inkCount, t1, t2 };
}

/** ภาพเตือนเส้นบางของชิ้นนั้น (null = ปิดอยู่) */
function thinOverlay(part = S.uvPart, g = S.gender) {
    return S.thinWarn ? thinParts[g + ':' + part] || null : null;
}

/** เลเยอร์นี้ใช้กับเพศ g ไหม (L.only = 'male' / 'female' = เพศเดียว เช่นเปิดจาก .ytd ของเพศนั้น) */
const forGender = (L, g = S.gender) => !L.only || L.only === g;

function compose(part = S.uvPart, g = S.gender) {
    const key = g + ':' + part;
    const c = composedParts[key] || (composedParts[key] = canvasOf(SIZE));
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);
    for (const L of S.layers) {
        if (!L.visible || !forGender(L, g)) continue;
        if (onBody(L)) {
            ctx.drawImage((g === S.gender ? BodyView.bake(L) : BodyView.bakeFor(L, g)).parts[part].ink, 0, 0);
        } else {
            inGender(L, g, () => {
                if (partOf(L) === part) for (const [ox, oy] of offsets()) drawLayer(ctx, L, ox, oy);
            });
        }
    }
    inkPost(ctx, SIZE);
    // SIZE = GAME_RES: ภาพนี้คือขนาดเดียวกับที่เกมใช้ — วัดเส้นบางจากตรงนี้
    if (S.thinWarn) thinCheck(key, ctx.getImageData(0, 0, SIZE, SIZE).data, SIZE);
    return c;
}

/** เลเยอร์นี้มีหมึกลงชิ้น part (ของเพศ g) ไหม */
function layerOnPart(L, part, g = S.gender) {
    if (!L.visible || !forGender(L, g)) return false;
    if (onBody(L)) return (g === S.gender ? BodyView.bake(L) : BodyView.bakeFor(L, g)).parts[part].any;
    return inGender(L, g, () => partOf(L) === part);
}

/** ลายนิ้วมือของสถานะตอนนี้ — พรีวิวความละเอียดสูงใช้ตรวจว่ายังตรงไหม */
function stateKey() {
    return [S.gender, S.wrapX, S.wrapY, S.inkThick, S.inkSharp].concat(S.layers.map((L) => [
        L.id, L.visible, L.place, L.part, L.x, L.y, L.scale, L.sx, L.sy, L.rot, L.flipX, L.flipY,
        L.color, L.maskVer, L.view ? L.view.n.join() : '',
    ].join(','))).join(';');
}

// ───────────────────────────────────────────── view ──────────────

const view = $('view');
const vctx = view.getContext('2d');
let K = 1;          // px ต่อ 1 พิกเซลของภาพ
let M = 0;          // ขอบรอบภาพ (หน่วยพิกเซลของภาพ)

function layoutView() {
    M = S.tile ? 112 : 16;
    const wrap = $('stageWrap');
    const total = SIZE + M * 2;
    if (S.zoom === 'fit') {
        const avail = Math.min(wrap.clientWidth - 40, wrap.clientHeight - 40);
        K = Math.max(0.4, avail / total);
    } else {
        K = Number(S.zoom);
    }
    const dpr = window.devicePixelRatio || 1;
    view.style.width = Math.round(total * K) + 'px';
    view.style.height = Math.round(total * K) + 'px';
    view.width = Math.round(total * K * dpr);
    view.height = Math.round(total * K * dpr);
}

/** จุดจับยืด/ย่อของเลเยอร์แบบบนภาพ: มุม = ย่อขยายทั้งรูป · ขอบ = ยืดกว้าง / สูง */
function handles(L) {
    const c = Math.cos(L.rot * Math.PI / 180), s = Math.sin(L.rot * Math.PI / 180);
    const hw = L.w * L.scale * L.sx / 2, hh = L.h * L.scale * L.sy / 2;
    const at = (x, y) => [L.x + x * c - y * s, L.y + x * s + y * c];
    return [
        { kind: 'corner', p: at(-hw, -hh) }, { kind: 'corner', p: at(hw, -hh) },
        { kind: 'corner', p: at(hw, hh) }, { kind: 'corner', p: at(-hw, hh) },
        { kind: 'sx', p: at(hw, 0) }, { kind: 'sx', p: at(-hw, 0) },
        { kind: 'sy', p: at(0, hh) }, { kind: 'sy', p: at(0, -hh) },
    ];
}

function showsHandles(L) {
    return L && L.visible && !onBody(L) && partOf(L) === S.uvPart;
}

function render() {
    const dpr = window.devicePixelRatio || 1;
    const total = SIZE + M * 2;
    const ctx = vctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.setTransform(K * dpr, 0, 0, K * dpr, M * K * dpr, M * K * dpr);
    ctx.imageSmoothingQuality = 'high';

    // ภาพต่อเนื่องรอบขอบ (จาง)
    const tex = compose();
    if (S.tile) {
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = PAPER;
        ctx.fillRect(-M, -M, total, total);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 0.45;
        for (let ox = -SIZE; ox <= SIZE; ox += SIZE) {
            for (let oy = -SIZE; oy <= SIZE; oy += SIZE) {
                if (!ox && !oy) continue;
                if ((ox && !S.wrapX) || (oy && !S.wrapY)) continue;
                ctx.drawImage(tex, ox, oy);
            }
        }
        ctx.restore();
    }

    // กระดาษ + ไกด์ลายเดิม (ลายเดิมมีแค่ท่อนบน)
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, SIZE, SIZE);
    if (S.uvPart === 'upper') {
        ctx.save();
        if (S.refAll) {
            ctx.globalAlpha = S.refOpacity * 0.45;
            for (const name in refs) ctx.drawImage(refs[name], 0, 0, SIZE, SIZE);
        }
        if (S.refPick && refs[S.refPick]) {
            ctx.globalAlpha = S.refOpacity;
            ctx.drawImage(refs[S.refPick], 0, 0, SIZE, SIZE);
        }
        ctx.restore();
    }

    // ตาราง
    if (S.grid) {
        ctx.save();
        ctx.lineWidth = 1 / K;
        for (let i = 64; i < SIZE; i += 64) {
            ctx.strokeStyle = i === SIZE / 2 ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.08)';
            ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, SIZE); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(SIZE, i); ctx.stroke();
        }
        ctx.restore();
    }

    // ลายของเรา (พรีวิวความละเอียดสูงถ้าอบเสร็จแล้ว — ซูมแล้วคมกว่า)
    const hi = window.BodyView && BodyView.hiResOf(S.uvPart);
    ctx.drawImage(hi || tex, 0, 0, SIZE, SIZE);
    const thin = thinOverlay();
    if (thin) ctx.drawImage(thin, 0, 0, SIZE, SIZE);

    // ชิ้นผิวของโมเดล: นอกตัวทำมืด + เส้นขอบชิ้น (body.js)
    if (S.uvGuide && window.BodyView) BodyView.drawUvGuide(ctx, K);

    // รอยต่อ
    ctx.save();
    ctx.lineWidth = 2 / K;
    ctx.setLineDash([6 / K, 5 / K]);
    ctx.strokeStyle = '#6fb6e8';
    if (S.wrapX) {
        ctx.beginPath(); ctx.moveTo(0, -M); ctx.lineTo(0, SIZE + M); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(SIZE, -M); ctx.lineTo(SIZE, SIZE + M); ctx.stroke();
    }
    if (S.wrapY) {
        ctx.beginPath(); ctx.moveTo(-M, 0); ctx.lineTo(SIZE + M, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-M, SIZE); ctx.lineTo(SIZE + M, SIZE); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1 / K;
    ctx.strokeRect(0, 0, SIZE, SIZE);
    ctx.restore();

    // กรอบเลเยอร์ที่เลือก
    const L = selected();
    if (L && L.visible && onBody(L)) {
        // ลายติดบนตัว: กรอบตามรูปร่างที่ตกลงบนภาพจริง
        const line = BodyView.bake(L).parts[S.uvPart].line;
        ctx.save();
        for (const [ox, oy] of S.tile ? offsets() : [[0, 0]]) {
            ctx.globalAlpha = ox || oy ? 0.4 : 1;
            ctx.drawImage(line, ox, oy);
        }
        ctx.globalAlpha = 1;
        if (partOf(L) === S.uvPart) {
            ctx.fillStyle = '#e6007a';
            ctx.beginPath(); ctx.arc(L.x, L.y, 3.5 / K, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
    } else if (showsHandles(L)) {
        // ทุกตำแหน่งที่ห่อไปโผล่
        for (const [ox, oy] of offsets()) {
            const pts = corners(L, ox, oy);
            const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
            const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
            if (maxX < -M || minX > SIZE + M || maxY < -M || minY > SIZE + M) continue;
            ctx.save();
            ctx.lineWidth = 1.5 / K;
            ctx.strokeStyle = ox || oy ? 'rgba(80,80,80,0.5)' : '#1a1a1a';
            ctx.setLineDash(ox || oy ? [4 / K, 4 / K] : []);
            ctx.beginPath();
            pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
        }
        // จุดจับยืด/ย่อ
        ctx.save();
        ctx.lineWidth = 1.5 / K;
        for (const h of handles(L)) {
            const r = (h.kind === 'corner' ? 5 : 4) / K;
            ctx.fillStyle = h.kind === 'corner' ? '#ffffff' : '#6fb6e8';
            ctx.strokeStyle = '#1a1a1a';
            ctx.beginPath();
            ctx.rect(h.p[0] - r, h.p[1] - r, r * 2, r * 2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath(); ctx.arc(L.x, L.y, 3.5 / K, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }

    updateStatus();
    if (window.BodyView) BodyView.update();
}

function corners(L, ox, oy) {
    const c = Math.cos(L.rot * Math.PI / 180), s = Math.sin(L.rot * Math.PI / 180);
    const hw = L.w * L.scale * L.sx / 2, hh = L.h * L.scale * L.sy / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [L.x + ox + x * c - y * s, L.y + oy + x * s + y * c]);
}

/** จุด (tx, ty) บนภาพ UV ที่แสดงอยู่โดนเลเยอร์นี้ไหม */
function hit(L, tx, ty) {
    if (onBody(L)) return BodyView.bakedHit(L, tx, ty, S.uvPart);
    if (partOf(L) !== S.uvPart) return false;
    for (const [ox, oy] of offsets()) {
        const dx = tx - (L.x + ox), dy = ty - (L.y + oy);
        const r = -L.rot * Math.PI / 180;
        const lx = (dx * Math.cos(r) - dy * Math.sin(r)) / (L.scale * L.sx);
        const ly = (dx * Math.sin(r) + dy * Math.cos(r)) / (L.scale * L.sy);
        if (Math.abs(lx) <= L.w / 2 && Math.abs(ly) <= L.h / 2) return true;
    }
    return false;
}

function toTex(e) {
    const r = view.getBoundingClientRect();
    return [(e.clientX - r.left) / K - M, (e.clientY - r.top) / K - M];
}

/** ขนาดจริงบนตัว (ซม.) ของลายติดบนตัว */
function sizeCm(L) {
    const mpp = BodyView.metersPerPixel(partOf(L)) * L.scale * 100;
    return [Math.round(L.w * L.sx * mpp), Math.round(L.h * L.sy * mpp)];
}

function updateStatus() {
    const L = selected();
    if (!S.layers.length) { $('status').textContent = 'ยังไม่มีเลเยอร์ — เพิ่มรูปลายทางซ้าย หรือลากไฟล์มาวาง'; return; }
    if (!L) { $('status').textContent = `${S.layers.length} เลเยอร์`; return; }
    if (onBody(L)) {
        const [cw, ch] = sizeCm(L);
        $('status').textContent = `${L.name} · ${PLACE_NAME[L.place] || 'บนตัว'} (${PART_NAME[partOf(L)]})`
            + ` · กว้าง ${cw} × สูง ${ch} ซม. · ${Math.round(L.rot)}° · ต่อข้ามรอยต่อเอง (Alt+คลิกชิ้น = แยกชิ้น)`;
        return;
    }
    const cross = corners(L, 0, 0).some(([x, y]) => x < 0 || x > SIZE || y < 0 || y > SIZE);
    $('status').textContent = `${L.name} · บนภาพ${PART_NAME[partOf(L)]} · X ${Math.round(L.x)} Y ${Math.round(L.y)}`
        + ` · ${Math.round(L.scale * 100)}% · ${Math.round(L.rot)}°`
        + (partOf(L) !== S.uvPart ? ` · อยู่บนภาพ${PART_NAME[partOf(L)]} (สลับภาพ UV เพื่อดู)` : '')
        + (cross ? (S.wrapX || S.wrapY ? ' · คร่อมรอยต่อ (Alt+คลิกชิ้นอีกฝั่ง = แยกชิ้น)' : ' · ตกขอบ (ส่วนนั้นจะหายไป)') : '');
}

// ───────────────────────────────────────────── แยกชิ้น ───────────

/** ภาพของเลเยอร์เดียวบนภาพ UV ของชิ้น part */
function layerImage(L, part) {
    if (onBody(L)) return BodyView.bake(L).parts[part].ink.getContext('2d').getImageData(0, 0, SIZE, SIZE);
    const c = canvasOf(SIZE);
    const ctx = c.getContext('2d');
    if (partOf(L) === part) for (const [ox, oy] of offsets()) drawLayer(ctx, L, ox, oy);
    return ctx.getImageData(0, 0, SIZE, SIZE);
}

/** หมึกของเลเยอร์บนภาพชิ้นนั้น แบ่งเป็นก้อน: อยู่เกาะ UV เดียวกัน และห่างกันไม่เกิน ~1 ช่อง (8 พิกเซล)
 *  ตัวอักษร/ลายที่ขาดเป็นช่วง ๆ ยังเป็นก้อนเดียว · ครึ่งที่พาดข้ามรอยต่อไปอยู่อีกฝั่งของภาพแยกเป็นอีกก้อน */
function inkPieces(img, isl, part) {
    const CELL = 8, GN = SIZE / CELL;
    const node = new Map();                              // "เกาะ:ช่อง" → เลขก้อน
    const parent = [];
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const texNode = new Int32Array(SIZE * SIZE).fill(-1);
    for (let i = 0; i < SIZE * SIZE; i++) {
        if (img.data[i * 4 + 3] < 8 || isl[i] < 0) continue;
        const cell = ((i / SIZE / CELL) | 0) * GN + ((i % SIZE) / CELL | 0);
        const key = isl[i] + ':' + cell;
        let id = node.get(key);
        if (id === undefined) { id = parent.length; parent.push(id); node.set(key, id); }
        texNode[i] = id;
    }
    for (const [key, id] of node) {
        const [island, cell] = key.split(':').map(Number);
        const cx = cell % GN, cy = (cell / GN) | 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = cx + dx, ny = cy + dy;
                if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= GN || ny >= GN) continue;
                const other = node.get(island + ':' + (ny * GN + nx));
                if (other !== undefined) parent[find(other)] = find(id);
            }
        }
    }
    const groups = new Map();
    for (let i = 0; i < SIZE * SIZE; i++) {
        if (texNode[i] < 0) continue;
        const root = find(texNode[i]);
        let g = groups.get(root);
        if (!g) groups.set(root, g = { part, img, idx: [], x0: SIZE, y0: SIZE, x1: -1, y1: -1 });
        const x = i % SIZE, y = (i / SIZE) | 0;
        g.idx.push(i);
        if (x < g.x0) g.x0 = x; if (x > g.x1) g.x1 = x;
        if (y < g.y0) g.y0 = y; if (y > g.y1) g.y1 = y;
    }
    return [...groups.values()].filter((g) => g.idx.length >= 6);
}

/** แตกเลเยอร์เป็นชิ้น (ชิ้นที่พาดข้ามรอยต่อไปอีกฝั่งกลายเป็นเลเยอร์ของตัวเอง ขยับแยกได้)
 *  @param at { part, x, y } ชิ้นที่ถูกคลิก — เลือกเลเยอร์ของชิ้นนั้นให้หลังแยก */
async function splitLayer(L, at) {
    if (!window.BodyView) return;
    const pieces = [];
    for (const part of BodyView.PAINTABLE) {
        pieces.push(...inkPieces(layerImage(L, part), BodyView.texelIslands(part), part));
    }
    if (pieces.length < 2) {
        toast('ลายนี้อยู่บนชิ้นผิวเดียว ไม่ได้พาดข้ามรอยต่อ — ไม่ต้องแยก', true);
        return;
    }

    checkpoint();
    const index = S.layers.indexOf(L);
    const made = [];
    let pickLayer = null;
    pieces.sort((a, b) => b.idx.length - a.idx.length);
    for (let k = 0; k < pieces.length; k++) {
        const g = pieces[k];
        const w = g.x1 - g.x0 + 1, h = g.y1 - g.y0 + 1;
        const c = canvasOf(w, h);
        const ctx = c.getContext('2d');
        const out = ctx.createImageData(w, h);
        for (const i of g.idx) {
            const x = i % SIZE - g.x0, y = ((i / SIZE) | 0) - g.y0;
            out.data.set(g.img.data.subarray(i * 4, i * 4 + 4), (y * w + x) * 4);
        }
        ctx.putImageData(out, 0, 0);
        const NL = await addLayer(c.toDataURL('image/png'), {
            name: `${L.name} · ชิ้น ${k + 1}${g.part === 'lower' ? ' (ขา)' : ''}`,
            place: 'uv', part: g.part, x: g.x0 + w / 2, y: g.y0 + h / 2,
            scale: 1, sx: 1, sy: 1, rot: 0, flipX: false, flipY: false,
            mode: 'alpha', threshold: 0, gain: 100, invert: false, color: !!L.color, visible: true,
            erase: null, poses: {}, noHistory: true,
        });
        made.push(NL);
        if (at && at.part === g.part) {
            const ti = Math.floor(at.y) * SIZE + Math.floor(mod(at.x, SIZE));
            if (g.idx.includes(ti)) pickLayer = NL;
        }
    }
    S.layers = S.layers.filter((x) => x !== L && !made.includes(x));
    S.layers.splice(index, 0, ...made);
    S.sel = pickLayer || made[0];
    if (S.sel && partOf(S.sel) !== S.uvPart && window.BodyView) BodyView.setUvPart(partOf(S.sel));
    refreshAll();
    toast(`แยกเป็น ${made.length} ชิ้นแล้ว — ขยับแต่ละชิ้นแยกกันได้ (เป็นแบบบนภาพ UV)`);
}

// ───────────────────────────────────────────── mouse ─────────────

let drag = null;

function handleAt(L, tx, ty) {
    if (!showsHandles(L)) return null;
    const r = 7 / K;
    return handles(L).find((h) => Math.abs(h.p[0] - tx) <= r && Math.abs(h.p[1] - ty) <= r) || null;
}

/** ระยะจุด (tx, ty) จากกลางเลเยอร์ ตามแกนของเลเยอร์ */
function localOf(L, tx, ty) {
    const r = -L.rot * Math.PI / 180;
    const dx = tx - L.x, dy = ty - L.y;
    return [dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)];
}

view.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const [tx, ty] = toTex(e);

    // ยางลบ / แปรงคืนลาย: ลบเลเยอร์ที่เลือก
    if (S.tool !== 'move') {
        const L = selected();
        if (!L) return toast('เลือกเลเยอร์ที่จะลบก่อน', true);
        beginStroke(L);
        paintAt(S.uvPart, tx, ty);
        drag = { paint: true };
        return;
    }

    // จุดจับยืด/ย่อของเลเยอร์ที่เลือก
    const cur = selected();
    const h = cur && handleAt(cur, tx, ty);
    if (h) {
        checkpoint();
        const [lx, ly] = localOf(cur, tx, ty);
        drag = { L: cur, handle: h.kind, lx, ly, scale: cur.scale, sx: cur.sx, sy: cur.sy };
        return;
    }

    let target = null;
    for (let i = S.layers.length - 1; i >= 0; i--) {
        const L = S.layers[i];
        if (L.visible && forGender(L) && hit(L, tx, ty)) { target = L; break; }
    }
    if (target && e.altKey) {
        splitLayer(target, { part: S.uvPart, x: tx, y: ty });
        return;
    }
    S.sel = target;
    if (target) {
        checkpoint();
        // ลายติดบนตัวที่จุดกลางอยู่อีกชิ้น (เช่นอยู่ที่ขา แต่ลากบนภาพท่อนบน) — ย้ายจุดกลางมาที่เมาส์
        if (onBody(target) && partOf(target) !== S.uvPart) {
            target.part = S.uvPart;
            target.x = tx;
            target.y = ty;
        }
        drag = { L: target, tx, ty, x: target.x, y: target.y };
        view.classList.add('grabbing');
    }
    refreshAll();
});

window.addEventListener('mousemove', (e) => {
    const [tx, ty] = toTex(e);
    if (S.tool !== 'move' && e.target === view) {
        showBrush(e.clientX, e.clientY, brushTexels(S.uvPart) * K);
    } else if (S.tool !== 'move' && !(drag && drag.paint) && e.target !== $('body3d')) {
        hideBrush();
    }
    if (drag && drag.paint) {
        paintAt(S.uvPart, tx, ty);
        return;
    }
    if (!drag) {
        const cur = selected();
        const h = cur && handleAt(cur, tx, ty);
        view.style.cursor = h ? (h.kind === 'corner' ? 'nwse-resize' : h.kind === 'sx' ? 'ew-resize' : 'ns-resize') : '';
        const over = !h && S.layers.some((L) => L.visible && forGender(L) && hit(L, tx, ty));
        view.classList.toggle('grab', over);
        return;
    }
    const L = drag.L;
    if (drag.handle) {
        const [lx, ly] = localOf(L, tx, ty);
        if (drag.handle === 'corner') {
            const k = Math.hypot(lx, ly) / Math.max(1e-6, Math.hypot(drag.lx, drag.ly));
            L.scale = clamp(drag.scale * k, 0.02, 8);
        } else if (drag.handle === 'sx') {
            L.sx = clamp(drag.sx * Math.abs(lx) / Math.max(1e-6, Math.abs(drag.lx)), 0.05, 20);
        } else {
            L.sy = clamp(drag.sy * Math.abs(ly) / Math.max(1e-6, Math.abs(drag.ly)), 0.05, 20);
        }
    } else {
        L.x = drag.x + (tx - drag.tx);
        L.y = drag.y + (ty - drag.ty);
        if (S.wrapX) L.x = mod(L.x, SIZE);
        if (S.wrapY) L.y = mod(L.y, SIZE);
    }
    render();
    syncProps();
});

window.addEventListener('mouseup', () => {
    if (!drag) return;
    if (drag.paint) {
        drag = null;
        endStroke();
        return;
    }
    drag = null;
    view.classList.remove('grabbing');
    refreshAll();
});

view.addEventListener('wheel', (e) => {
    const L = selected();
    if (!L) return;
    e.preventDefault();
    const dir = (e.deltaY || e.deltaX) < 0 ? 1 : -1;
    checkpointBurst();
    if (e.shiftKey) L.rot = mod(L.rot + dir * (e.altKey ? 1 : 5) + 180, 360) - 180;
    else L.scale = clamp(L.scale * (1 + dir * (e.altKey ? 0.01 : 0.05)), 0.02, 8);
    render();
    syncProps();
}, { passive: false });

// วางไฟล์รูป
const wrapEl = $('stageWrap');
['dragenter', 'dragover'].forEach((ev) => wrapEl.addEventListener(ev, (e) => { e.preventDefault(); wrapEl.classList.add('drop'); }));
['dragleave', 'drop'].forEach((ev) => wrapEl.addEventListener(ev, (e) => { e.preventDefault(); wrapEl.classList.remove('drop'); }));
wrapEl.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

function addFiles(files) {
    [...files].filter((f) => /\.ytd$/i.test(f.name)).forEach((f) => openYtd(f));
    [...files].filter((f) => f.type.startsWith('image/')).forEach((f) => {
        const r = new FileReader();
        r.onload = () => addLayer(r.result, { name: f.name.replace(/\.[^.]+$/, '') }).catch(() => toast('เปิดรูปไม่ได้: ' + f.name, true));
        r.readAsDataURL(f);
    });
}

// ───────────────────────────────────────────── เปิด .ytd ─────────
// อ่านไฟล์ลายที่ทำไว้แล้ว (จาก Tool นี้ / ลายเดิม / export จาก CodeX) กลับมาเป็นเลเยอร์บนภาพ UV ตรงตำแหน่งเดิม
// ชื่อไฟล์บอกส่วนกับเพศ: _legs = ขา · _fr / _f = หญิง · _mr หรือไม่มีท้าย = ชาย (แบบที่ Tool ตั้งชื่อ)

async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('เบราว์เซอร์นี้แตกไฟล์ไม่ได้ ใช้ Chrome / Edge / Opera รุ่นใหม่');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ชื่อไฟล์ → { base, part, only } */
function ytdNameInfo(fileName) {
    let base = fileName.replace(/\.ytd$/i, '');
    let only = 'male';
    const g = base.match(/_(mr|fr|f)$/i);
    if (g) {
        only = g[1].toLowerCase() === 'mr' ? 'male' : 'female';
        base = base.slice(0, -g[0].length);
    }
    const legs = /_legs$/i.test(base);
    if (legs) base = base.replace(/_legs$/i, '');
    return { base, part: legs ? 'lower' : 'upper', only };
}

/** ลายหมึกเดียวในเกมเก็บแบบ (0, G, 0) + alpha — แดง/น้ำเงินว่างทั้งภาพ = หมึกเดียว */
function isMonoInk(rgba) {
    let any = false;
    for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] < 16) continue;
        any = true;
        if (rgba[i] > 12 || rgba[i + 2] > 12) return false;
    }
    return any;
}

async function openYtd(file) {
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { virtualSize } = TattooYtd.readYtdHeader(bytes);
        let body;
        try {
            body = await inflateRaw(bytes.subarray(16));
        } catch (err) {
            throw new Error('แตกไฟล์ไม่ได้ — ไฟล์ที่ดึงจากเกมตรง ๆ บีบอัดแบบ Oodle ให้เปิดใน CodeX แล้ว export เป็น .ytd ก่อน');
        }
        const all = TattooYtd.parseYtd(body, virtualSize);
        // texture สีผิว/ลาย = *_ab · ข้าม material / normal
        let picks = all.filter((t) => /_ab$/i.test(t.name));
        if (!picks.length) picks = all.filter((t) => !/_(ma|nm|n|m)$/i.test(t.name));
        if (!picks.length) throw new Error('ไม่มี texture ลาย (_ab) ในไฟล์');

        const info = ytdNameInfo(file.name);
        for (const t of picks) {
            const rgba = TattooYtd.decodeTexture(body, t);
            const mono = isMonoInk(rgba);
            // หมึกเดียว: เก็บแค่ alpha เป็นหมึกดำ (สีหมึกเลือกในร้าน) · ลายสี: ใช้สีตามไฟล์
            if (mono) for (let i = 0; i < rgba.length; i += 4) rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
            const c = canvasOf(t.w, t.h);
            c.getContext('2d').putImageData(new ImageData(rgba, t.w, t.h), 0, 0);

            if (window.BodyView && S.uvPart !== info.part) BodyView.setUvPart(info.part);
            const L = await addLayer(c.toDataURL('image/png'), {
                name: picks.length > 1 ? t.name : file.name.replace(/\.ytd$/i, ''),
                place: 'uv', part: info.part, x: SIZE / 2, y: SIZE / 2, rot: 0, sx: 1, sy: 1,
                mode: 'alpha', threshold: 0, color: !mono, only: info.only,
            });
            // ภาพ UV ทั้งแผ่น: เต็มภาพพอดี (ไฟล์ 1024 / 2048 = ย่อแสดง แต่ส่งออกจากรูปเต็ม)
            L.scale = SIZE / Math.max(L.w, L.h);
            // ตำแหน่งบนภาพเหมือนกันทุกเพศ — ไม่ให้ระบบเดาตำแหน่งของอีกเพศจากตัว 3D
            const pose = { x: L.x, y: L.y, part: L.part, scale: L.scale, sx: 1, sy: 1, rot: 0, view: undefined };
            L.poses = { male: Object.assign({}, pose), female: Object.assign({}, pose) };
        }

        // ตั้งชื่อส่งออกให้ถ้ายังว่าง (ชื่อที่ไม่มี _mr / _fr / _legs)
        if (!$('eName').value.trim()) $('eName').value = info.base.toLowerCase();
        if (window.BodyView && S.gender !== info.only) BodyView.setGender(info.only);
        refreshAll();
        const sizes = [...new Set(picks.map((t) => t.w + '×' + t.h))].join(', ');
        toast(`เปิด ${file.name} แล้ว (${sizes} · ${PART_NAME[info.part]} · ${GENDER_NAME[info.only]}เท่านั้น — เปลี่ยนได้ที่ "ใช้กับตัวละคร")`);
    } catch (err) {
        toast(`เปิด ${file.name} ไม่ได้: ${err.message}`, true);
    }
}

$('btnYtdOpen').addEventListener('click', () => $('fileYtdOpen').click());
$('fileYtdOpen').addEventListener('change', (e) => { [...e.target.files].forEach((f) => openYtd(f)); e.target.value = ''; });

// ───────────────────────────────────────────── keyboard ──────────

window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey && key === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (e.ctrlKey && key === 'y') { e.preventDefault(); return redo(); }
    if (!e.ctrlKey && !e.altKey) {
        if (key === 'm') return setTool('move');
        if (key === 'e') return setTool('erase');
        if (key === 'r') return setTool('restore');
        if (S.tool !== 'move' && (key === '[' || key === ']')) {
            setBrushSize(brush.size * (key === ']' ? 1.15 : 1 / 1.15));
            return;
        }
    }
    const L = selected();
    if (!L) return;
    const n = e.shiftKey ? 10 : 1;
    let handled = true;
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'h', 'v', '[', ']', '+', '=', '-'].includes(key)) checkpointBurst();
    switch (e.key) {
        case 'ArrowLeft': L.x -= n; break;
        case 'ArrowRight': L.x += n; break;
        case 'ArrowUp': L.y -= n; break;
        case 'ArrowDown': L.y += n; break;
        case 'Delete': case 'Backspace': removeLayer(L); return;
        case 'h': case 'H': case 'v': case 'V':
            if (e.key.toLowerCase() === 'h') L.flipX = !L.flipX; else L.flipY = !L.flipY;
            break;
        case '[': L.rot -= n; break;
        case ']': L.rot += n; break;
        case '+': case '=': L.scale = clamp(L.scale * 1.05, 0.02, 8); break;
        case '-': L.scale = clamp(L.scale / 1.05, 0.02, 8); break;
        case 'd': case 'D':
            if (e.ctrlKey) { e.preventDefault(); duplicate(L, false); return; }
            handled = false; break;
        default: handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    if (S.wrapX) L.x = mod(L.x, SIZE);
    if (S.wrapY) L.y = mod(L.y, SIZE);
    refreshAll();
});

// ───────────────────────────────────────────── layer list ────────

function refreshList() {
    $('layers').innerHTML = S.layers.slice().reverse().map((L) => `
        <li data-id="${L.id}" class="${L === selected() ? 'sel' : ''} ${L.visible ? '' : 'off'}">
            <span class="thumb" style="background-image:url(${layerThumb(L)})"></span>
            <span class="lname">${L.name.replace(/[<>&]/g, '')}<small>${onBody(L) ? PLACE_NAME[L.place] || 'บนตัว' : 'บนภาพ' + PART_NAME[partOf(L)]}${L.color ? ' · สี' : ''}${L.only ? ' · ' + (L.only === 'male' ? 'ชาย' : 'หญิง') + 'เท่านั้น' : ''}${L.erase ? ' · ลบบางส่วน' : ''}</small></span>
            <span class="lbtns">
                <button data-act="eye" title="ซ่อน/แสดง">${L.visible ? '◉' : '○'}</button>
                <button data-act="up" title="ขึ้นบน">▲</button>
                <button data-act="down" title="ลงล่าง">▼</button>
            </span>
        </li>`).join('');
}

$('layers').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const L = S.layers.find((x) => x.id === Number(li.dataset.id));
    if (!L) return;
    const act = e.target.closest('button') && e.target.closest('button').dataset.act;
    const i = S.layers.indexOf(L);
    if (act) checkpoint();
    if (act === 'eye') L.visible = !L.visible;
    else if (act === 'up' && i < S.layers.length - 1) [S.layers[i], S.layers[i + 1]] = [S.layers[i + 1], S.layers[i]];
    else if (act === 'down' && i > 0) [S.layers[i], S.layers[i - 1]] = [S.layers[i - 1], S.layers[i]];
    else {
        S.sel = L;
        // เลเยอร์แบบบนภาพอยู่ชิ้นไหน ให้ภาพ UV ตามไปชิ้นนั้น
        if (!onBody(L) && partOf(L) !== S.uvPart && window.BodyView) return BodyView.setUvPart(partOf(L));
    }
    refreshAll();
});

// ───────────────────────────────────────────── properties ────────

const pct = (key) => ({ get: (L) => L[key] * 100, set: (L, v) => { L[key] = v / 100; } });

const STEPPERS = [
    { key: 'x', label: 'ตำแหน่ง X', min: -SIZE, max: SIZE * 2, step: 1, unit: '' },
    { key: 'y', label: 'ตำแหน่ง Y', min: -SIZE, max: SIZE * 2, step: 1, unit: '' },
    Object.assign({ key: 'scale', label: 'ขนาด', min: 2, max: 800, step: 1, unit: '%' }, pct('scale')),
    Object.assign({ key: 'sx', label: 'ยืดกว้าง', min: 5, max: 2000, step: 1, unit: '%' }, pct('sx')),
    Object.assign({ key: 'sy', label: 'ยืดสูง', min: 5, max: 2000, step: 1, unit: '%' }, pct('sy')),
    { key: 'rot', label: 'หมุน', min: -180, max: 180, step: 1, unit: '°' },
];

// ลูกศร ◀ ▶ ของช่องตัวเลข (วาดเอง — Tool ไม่ต้องพึ่งรูปจากหน้าร้าน ใช้บนเว็บได้)
const ARROW_LEFT = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M8 1.5 3.5 6 8 10.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ARROW_RIGHT = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 1.5 8.5 6 4 10.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function buildSteppers() {
    $('steppers').innerHTML = STEPPERS.map((s) => `
        <div class="stepper" data-key="${s.key}">
            <span>${s.label}</span>
            <span class="ctl">
                <button class="step" data-dir="-1" aria-label="ลด">${ARROW_LEFT}</button>
                <input type="text" inputmode="numeric">
                <button class="step" data-dir="1" aria-label="เพิ่ม">${ARROW_RIGHT}</button>
                <span class="unit">${s.unit}</span>
            </span>
        </div>`).join('');

    STEPPERS.forEach((s) => {
        const row = document.querySelector(`.stepper[data-key="${s.key}"]`);
        const input = row.querySelector('input');
        const get = (L) => (s.get ? s.get(L) : L[s.key]);
        const set = (L, v) => {
            v = clamp(v, s.min, s.max);
            if (s.set) s.set(L, v); else L[s.key] = v;
            if (s.key === 'x' && S.wrapX) L.x = mod(L.x, SIZE);
            if (s.key === 'y' && S.wrapY) L.y = mod(L.y, SIZE);
            render();
        };
        s.apply = (delta) => { const L = selected(); if (L) { checkpointBurst(); set(L, Math.round(get(L)) + delta); syncProps(); } };

        input.addEventListener('input', () => {
            const L = selected();
            const v = Number(input.value.replace(/[^0-9.-]/g, ''));
            if (L && input.value.trim() !== '' && !Number.isNaN(v)) { checkpointBurst(); set(L, v); }
        });
        input.addEventListener('blur', syncProps);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                s.apply((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
            }
        });

        row.querySelectorAll('.step').forEach((btn) => {
            const dir = Number(btn.dataset.dir);
            let timer = null;
            const stop = () => { clearTimeout(timer); timer = null; };
            btn.addEventListener('mousedown', () => {
                s.apply(dir * s.step);
                const t0 = Date.now();
                const tick = () => {
                    const held = Date.now() - t0;
                    s.apply(dir * s.step * (held > 2000 ? 10 : held > 1000 ? 3 : 1));
                    timer = setTimeout(tick, 50);
                };
                timer = setTimeout(tick, 350);
            });
            btn.addEventListener('mouseup', stop);
            btn.addEventListener('mouseleave', stop);
        });
    });
}

function syncProps() {
    const L = selected();
    $('noSel').classList.toggle('hidden', !!L);
    $('selProps').classList.toggle('hidden', !L);
    if (!L) return;
    STEPPERS.forEach((s) => {
        const input = document.querySelector(`.stepper[data-key="${s.key}"] input`);
        if (document.activeElement !== input) input.value = Math.round(s.get ? s.get(L) : L[s.key]);
    });
    if (document.activeElement !== $('pName')) $('pName').value = L.name;
    $('pFlipX').classList.toggle('on', L.flipX);
    $('pFlipY').classList.toggle('on', L.flipY);
    $('pMode').value = L.mode;
    $('pThreshold').value = L.threshold;
    $('pThresholdV').textContent = L.threshold;
    $('pGain').value = L.gain;
    $('pGainV').textContent = L.gain + '%';
    $('pInvert').checked = L.invert;
    $('pColor').checked = !!L.color;
    $('pOnly').value = L.only || '';
    $('pPlace').value = L.place || 'uv';
    $('pViewNow').classList.toggle('hidden', L.place !== 'view');
    $('pClearErase').disabled = !L.erase;
    updateStatus();
}

function withSel(fn) {
    return () => { const L = selected(); if (L) fn(L); };
}

$('pName').addEventListener('input', withSel((L) => { checkpointBurst(); L.name = $('pName').value || 'ลาย'; refreshList(); }));
$('pFlipX').addEventListener('click', withSel((L) => { checkpoint(); L.flipX = !L.flipX; refreshAll(); }));
$('pFlipY').addEventListener('click', withSel((L) => { checkpoint(); L.flipY = !L.flipY; refreshAll(); }));
$('pDup').addEventListener('click', withSel((L) => duplicate(L, false)));
$('pMirror').addEventListener('click', withSel((L) => duplicate(L, true)));
$('pSplit').addEventListener('click', withSel((L) => splitLayer(L)));
$('pResetStretch').addEventListener('click', withSel((L) => { checkpoint(); L.sx = 1; L.sy = 1; refreshAll(); }));
$('pClearErase').addEventListener('click', withSel((L) => { checkpoint(); L.erase = null; applyErase(L); refreshAll(); }));
$('pCopyPose').addEventListener('click', withSel((L) => {
    checkpoint();
    if (!BodyView.copyPoseFromOther(L)) {
        history.undo.pop();
        updateUndoButtons();
        return toast('อีกเพศยังไม่เคยจัดตำแหน่งลายนี้', true);
    }
    refreshAll();
}));
$('pViewNow').addEventListener('click', withSel((L) => { checkpoint(); L.view = BodyView.cameraFrame(); refreshAll(); }));
$('pCenter').addEventListener('click', withSel((L) => {
    checkpoint();
    Object.assign(L, onBody(L) ? BodyView.defaultAnchor() : { x: SIZE / 2, y: SIZE / 2 });
    refreshAll();
}));
$('pPlace').addEventListener('change', withSel((L) => {
    checkpoint();
    L.place = $('pPlace').value;
    // ฉายจากมุมกล้อง: ล็อกทิศตามกล้องตอนเลือก (กด "ใช้มุมกล้องตอนนี้" เพื่อเปลี่ยน)
    if (L.place === 'view' && window.BodyView) L.view = BodyView.cameraFrame();
    refreshAll();
}));
$('pDelete').addEventListener('click', withSel(removeLayer));

const reMask = withSel((L) => {
    checkpointBurst();
    L.mode = $('pMode').value;
    L.threshold = Number($('pThreshold').value);
    L.gain = Number($('pGain').value);
    L.invert = $('pInvert').checked;
    L.color = $('pColor').checked;
    rebuildMask(L);
    refreshAll();
});
['pMode', 'pInvert', 'pColor'].forEach((id) => $(id).addEventListener('change', reMask));
$('pOnly').addEventListener('change', withSel((L) => {
    checkpoint();
    L.only = $('pOnly').value || undefined;
    refreshAll();
}));
['pThreshold', 'pGain'].forEach((id) => $(id).addEventListener('input', reMask));

// ───────────────────────────────────────────── left panel ────────

$('btnAdd').addEventListener('click', () => $('fileImg').click());
$('fileImg').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

$('refAll').addEventListener('change', (e) => { S.refAll = e.target.checked; render(); });
$('refPick').addEventListener('change', (e) => { S.refPick = e.target.value; render(); });
$('refOpacity').addEventListener('input', (e) => { S.refOpacity = Number(e.target.value) / 100; render(); });
$('btnRefAsLayer').addEventListener('click', () => {
    const ref = (window.PLACER_REFS || []).find((r) => r.name === S.refPick);
    if (!ref) return toast('เลือกชุดลายเดิมจากรายการด้านบนก่อน', true);
    // ลายเดิมเป็นภาพ UV ท่อนบนทั้งแผ่นอยู่แล้ว — วางบนภาพตรง ๆ
    if (window.BodyView && S.uvPart !== 'upper') BodyView.setUvPart('upper');
    addLayer(ref.url, { name: ref.name, scale: 1, mode: 'alpha', threshold: 0, color: false, place: 'uv', part: 'upper', x: SIZE / 2, y: SIZE / 2 });
});

$('wrapX').addEventListener('change', (e) => { S.wrapX = e.target.checked; render(); });
$('wrapY').addEventListener('change', (e) => { S.wrapY = e.target.checked; render(); });
$('showTile').addEventListener('change', (e) => { S.tile = e.target.checked; layoutView(); render(); });
$('showGrid').addEventListener('change', (e) => { S.grid = e.target.checked; render(); });
$('zoomSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.zoom = b.dataset.z;
    document.querySelectorAll('#zoomSeg button').forEach((x) => x.classList.toggle('active', x === b));
    layoutView();
    render();
});
window.addEventListener('resize', () => { layoutView(); render(); });

function refreshAll() {
    refreshList();
    syncProps();
    render();
    updateExport();
    updateThinStat();
}

/** สรุปเส้นบางของภาพที่ดูอยู่ */
function updateThinStat() {
    const el = $('thinStat');
    const st = S.thinWarn && thinStats[S.gender + ':' + S.uvPart];
    el.classList.toggle('hidden', !st);
    if (!st) return;
    if (!st.ink) { el.textContent = 'ยังไม่มีหมึกบนภาพ' + PART_NAME[S.uvPart]; return; }
    const pct = (v) => (v / st.ink * 100).toFixed(v / st.ink < 0.1 ? 1 : 0) + '%';
    el.textContent = !st.t1 && !st.t2
        ? `ภาพ${PART_NAME[S.uvPart]}: ไม่มีเส้นบาง ✓`
        : `ภาพ${PART_NAME[S.uvPart]}: หายในเกม ${pct(st.t1)} · จาง/เบลอ ${pct(st.t2)} ของหมึก — ลองหนาเส้น +1 หรือขยายลาย`;
}

$('thinWarn').addEventListener('change', (e) => { S.thinWarn = e.target.checked; refreshAll(); });
$('inkThick').addEventListener('change', (e) => { S.inkThick = Number(e.target.value); refreshAll(); });
$('inkSharp').addEventListener('input', (e) => {
    S.inkSharp = Number(e.target.value) / 100;
    $('inkSharpV').textContent = e.target.value + '%';
    refreshAll();
});

// ───────────────────────────────────────────── ย้อนกลับ / ทำซ้ำ ─────

const HISTORY_KEYS = SAVED_KEYS();
const MASK_KEYS = ['mode', 'threshold', 'gain', 'invert', 'color'];
const history = { undo: [], redo: [], burstAt: 0 };

function SAVED_KEYS() {
    return ['name', 'x', 'y', 'part', 'scale', 'sx', 'sy', 'rot', 'flipX', 'flipY', 'mode', 'threshold', 'gain',
        'invert', 'color', 'visible', 'place', 'view', 'only'];
}

/** ส่วนที่ลบของเลเยอร์ ณ ตอนนี้ (เก็บซ้ำไม่ได้ถ้ายังไม่เปลี่ยน) */
function eraseState(L) {
    if (!L.erase) return null;
    if (!L.eraseSnap || L.eraseSnap.ver !== (L.eraseVer || 0)) {
        L.eraseSnap = { ver: L.eraseVer || 0, data: L.erase.getContext('2d').getImageData(0, 0, L.w, L.h) };
    }
    return L.eraseSnap;
}

const clonePoses = (p) => JSON.parse(JSON.stringify(p || {}));

function snapshot() {
    return {
        sel: S.sel,
        gender: S.gender,
        layers: S.layers.map((L) => ({
            L, erase: eraseState(L),
            props: Object.assign(Object.fromEntries(HISTORY_KEYS.map((k) => [k, L[k]])), { poses: clonePoses(L.poses) }),
        })),
    };
}

/** จำสถานะก่อนแก้ — เรียกก่อนทุกการเปลี่ยนแปลง */
function checkpoint() {
    history.undo.push(snapshot());
    if (history.undo.length > 60) history.undo.shift();
    history.redo.length = 0;
    history.burstAt = 0;
    updateUndoButtons();
}

/** การแก้ต่อเนื่อง (ล้อเมาส์ / ปุ่มลูกศร / ลากแถบ) นับเป็นขั้นเดียวถ้าห่างกันไม่เกิน 0.7 วินาที */
function checkpointBurst() {
    const now = performance.now();
    if (now - history.burstAt > 700) checkpoint();
    history.burstAt = now;
}

function restore(snap) {
    S.layers = snap.layers.map(({ L, props, erase }) => {
        const maskChanged = MASK_KEYS.some((k) => L[k] !== props[k]);
        const eraseChanged = (L.erase ? eraseState(L) : null) !== erase;
        Object.assign(L, props, { poses: clonePoses(props.poses) });
        if (eraseChanged) {
            if (erase) {
                if (!L.erase) L.erase = canvasOf(L.w, L.h);
                L.erase.getContext('2d').putImageData(erase.data, 0, 0);
                L.eraseVer = erase.ver;
                L.eraseSnap = erase;
            } else {
                L.erase = null;
            }
        }
        if (maskChanged) rebuildMask(L);
        else if (eraseChanged) applyErase(L);
        return L;
    });
    S.sel = S.layers.includes(snap.sel) ? snap.sel : null;
    if (window.BodyView && snap.gender !== S.gender) BodyView.setGenderRaw(snap.gender);
    refreshAll();
}

function undo() {
    if (!history.undo.length) return;
    history.redo.push(snapshot());
    restore(history.undo.pop());
    history.burstAt = 0;
    updateUndoButtons();
}

function redo() {
    if (!history.redo.length) return;
    history.undo.push(snapshot());
    restore(history.redo.pop());
    history.burstAt = 0;
    updateUndoButtons();
}

function updateUndoButtons() {
    $('btnUndo').disabled = !history.undo.length;
    $('btnRedo').disabled = !history.redo.length;
}

$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);

// ───────────────────────────────────────────── ยางลบ ─────────────

/** ขนาดแปรงเป็นพิกเซลบนภาพ UV 512 ของชิ้นนั้น */
function brushTexels(part) {
    const mpp = window.BodyView ? BodyView.metersPerPixel(part) : 0.0022;
    return (brush.size / 100) / mpp;
}

/** พิกเซล (tx, ty) บนภาพ UV ของชิ้น part ตกตรงไหนของรูปลาย L → { lx, ly } หรือ null */
function imageAt(L, part, tx, ty) {
    if (onBody(L)) return BodyView.imageAtTexel(L, part, tx, ty);
    if (partOf(L) !== part) return null;
    let best = null, bestD = Infinity;
    for (const [ox, oy] of offsets()) {
        const dx = tx - (L.x + ox), dy = ty - (L.y + oy);
        const r = -L.rot * Math.PI / 180;
        let lx = (dx * Math.cos(r) - dy * Math.sin(r)) / (L.scale * L.sx);
        let ly = (dx * Math.sin(r) + dy * Math.cos(r)) / (L.scale * L.sy);
        if (L.flipX) lx = -lx;
        if (L.flipY) ly = -ly;
        const d = Math.hypot(lx, ly);
        if (d < bestD) { bestD = d; best = { lx: lx + L.w / 2, ly: ly + L.h / 2 }; }
    }
    return best;
}

let stroke = null;

function beginStroke(L) {
    checkpoint();
    stroke = { L, last: null, raf: 0 };
}

/** จุดแปรงหนึ่งจุด (วงรีตามการยืดของรูป — บนตัวจะเป็นวงกลม) */
function dab(L, lx, ly, rx, ry) {
    if (!L.erase) L.erase = canvasOf(L.w, L.h);
    const ctx = L.erase.getContext('2d');
    ctx.save();
    ctx.setTransform(rx, 0, 0, ry, lx, ly);
    const g = ctx.createRadialGradient(0, 0, clamp(1 - brush.soft / 100, 0, 0.98), 0, 0, 1);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = S.tool === 'restore' ? 'destination-out' : 'source-over';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

/** ลากแปรงมาถึงพิกเซล (tx, ty) บนภาพ UV ของชิ้น part (เรียกได้ทั้งจาก 2D และตัว 3D) */
function paintAt(part, tx, ty) {
    if (!stroke) return;
    const L = stroke.L;
    const at = imageAt(L, part, tx, ty);
    if (!at) { stroke.last = null; return; }
    const r = brushTexels(part);
    const rx = r / (L.scale * L.sx), ry = r / (L.scale * L.sy);
    const from = stroke.last || at;
    const gap = Math.hypot((at.lx - from.lx) / rx, (at.ly - from.ly) / ry);
    // กระโดดไกล (ข้ามรอยต่อของลายบนภาพ UV) ไม่ลากเส้นเชื่อม
    const steps = gap > 8 ? 1 : Math.max(1, Math.ceil(gap / 0.3));
    for (let k = 1; k <= steps; k++) {
        const f = gap > 8 ? 1 : k / steps;
        dab(L, from.lx + (at.lx - from.lx) * f, from.ly + (at.ly - from.ly) * f, rx, ry);
    }
    stroke.last = at;
    if (!stroke.raf) {
        stroke.raf = requestAnimationFrame(() => {
            if (stroke) stroke.raf = 0;
            applyErase(L);
            render();
        });
    }
}

function endStroke() {
    if (!stroke) return;
    const L = stroke.L;
    cancelAnimationFrame(stroke.raf);
    stroke = null;
    L.eraseVer = (L.eraseVer || 0) + 1;
    applyErase(L);
    refreshAll();
}

function showBrush(x, y, r) {
    const el = $('brushCursor');
    el.classList.remove('hidden');
    el.classList.toggle('restore', S.tool === 'restore');
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = el.style.height = Math.max(4, r * 2) + 'px';
}

function hideBrush() {
    $('brushCursor').classList.add('hidden');
}

function setTool(tool) {
    S.tool = tool;
    document.querySelectorAll('#toolSeg button').forEach((b) => b.classList.toggle('active', b.dataset.t === tool));
    document.body.classList.toggle('painting', tool !== 'move');
    if (tool === 'move') hideBrush();
}

function setBrushSize(cm) {
    brush.size = clamp(Math.round(cm * 10) / 10, 0.2, 15);
    $('brushSize').value = brush.size;
    $('brushSizeV').textContent = brush.size + ' ซม.';
}

$('toolSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setTool(b.dataset.t);
});
$('brushSize').addEventListener('input', (e) => setBrushSize(Number(e.target.value)));
$('brushSoft').addEventListener('input', (e) => {
    brush.soft = Number(e.target.value);
    $('brushSoftV').textContent = brush.soft + '%';
});
view.addEventListener('mouseleave', () => { if (!(drag && drag.paint)) hideBrush(); });

// ───────────────────────────────────────────── export ────────────

const NAME_RE = /^[a-z0-9_]{3,40}$/;
const LEGS_SUFFIX = '_legs';

// ท้ายชื่อไฟล์ตามเพศ แบบชื่อโมเดลในเกม (mp_..._mr1 / _fr1)
const GENDER_SUFFIX = { male: '_mr', female: '_fr' };

/** ลายสี (color = true) ต้องเท่าผิวในเกม (512) — ใหญ่กว่านี้เกมวาดลงแค่แขนข้างเดียวแล้วขยาย 2 เท่า (ลองในเกมแล้ว)
 *  หมึกเดียว (palette) ใช้ 1024 / 2048 ได้ตามปกติ */
const COLOR_RES = 512;

const hasColorLayer = () => S.layers.some((L) => L.visible && L.color);

/** ความละเอียดที่จะส่งออกจริง (body.js ใช้ตัดสินพรีวิวความละเอียดสูงด้วย) */
function exportRes() {
    return hasColorLayer() ? COLOR_RES : Number($('eRes').value) || SIZE;
}

function exportInfo() {
    const name = $('eName').value.trim().toLowerCase();
    const label = $('eLabel').value.trim() || name;
    const price = Math.max(0, Math.floor(Number($('ePrice').value.replace(/[^0-9]/g, '')) || 0));
    const category = $('eCat').value;
    const key = name.replace(/^tattoo_/, '');
    const gender = $('eGender').value;
    const res = exportRes();
    // ชายและหญิง = ส่งออกแยกไฟล์ต่อเพศ (ตำแหน่งบนภาพไม่เหมือนกัน) · ไม่มีโมเดล = ไฟล์เดียว
    const genders = !window.BodyView ? [S.gender] : gender === 'both' ? ['male', 'female'] : [gender];
    const sets = genders.map((g) => ({
        g,
        suffix: GENDER_SUFFIX[g],
        parts: ['upper', 'lower'].filter((p) => S.layers.some((L) => layerOnPart(L, p, g))),
    }));
    const parts = [...new Set(sets.flatMap((x) => x.parts))];
    const color = hasColorLayer();
    return { name, label, price, category, key, gender, res, sets, parts, color };
}

/** ชื่อไฟล์ .ytd: ท่อนบน = <ชื่อ>_mr / _fr · ขา = <ชื่อ>_legs_mr / _legs_fr */
const fileOf = (e, part, set = { suffix: '' }) => e.name + (part === 'lower' ? LEGS_SUFFIX : '') + set.suffix;
const GENDER_NAME = { male: 'ชาย', female: 'หญิง' };

function updateExport() {
    const e = exportInfo();
    let warn = '';
    if (e.name && !NAME_RE.test(e.name)) warn = 'ชื่อไฟล์ใช้ได้แค่ a-z 0-9 _ ยาว 3-40 ตัว';
    else if ((window.PLACER_REFS || []).some((r) => r.name === e.name)) warn = 'ชื่อซ้ำกับลายเดิมในเกม — จะไปทับไฟล์เดิม ตั้งชื่อใหม่';
    $('eWarn').textContent = warn;
    $('eWarn').classList.toggle('hidden', !warn);
    const ok = NAME_RE.test(e.name) && !warn && e.parts.length > 0;
    ['btnYtd', 'btnAb', 'btnCopy'].forEach((id) => { $(id).disabled = !ok; });
    $('btnThumb').disabled = !(NAME_RE.test(e.name) && !warn && (e.parts.length > 0 || S.shot));

    const shown = { name: e.name || 'ชื่อ' };
    // ท่อนบนได้คู่ _sw ด้วย (ใช้ตอนใส่เสื้อ / ถุงมือ ที่แขนซ้าย-ขวาสลับบนภาพ)
    const list = e.sets.flatMap((set) => set.parts.map((p) =>
        `${fileOf(shown, p, set)}.ytd${p === 'upper' ? ' + _sw' : ''} (${e.sets.length > 1 ? GENDER_NAME[set.g] + ' ' : ''}${PART_NAME[p]})`));
    $('eFiles').textContent = list.length
        ? 'จะได้ไฟล์: ' + list.join(' + ') + ` · ${e.res}×${e.res}`
            + (e.color ? ` · ลายสี (ใช้ ${COLOR_RES} เสมอ — ใหญ่กว่านี้เกมวางผิดที่)` : ' · หมึกเดียว')
        : 'ยังไม่มีลายลงตัว';
    // ลายสีล็อกความละเอียดไว้ที่ 512
    $('eRes').disabled = e.color;

    if (!e.name) { $('eConfig').value = ''; return; }
    const fields = [
        `key = '${e.key}'`,
        `label = '${e.label.replace(/'/g, "\\'")}'`,
        `category = '${e.category}'`,
        `price = ${e.price}`,
    ];
    // ชายใช้ texture / legs · หญิงใช้ textureF / legsF (false = ไม่มีลายส่วนนั้น)
    for (const set of e.sets) {
        // ส่งออกทั้งสองเพศ: ไฟล์ผู้หญิงลง textureF / legsF · เพศเดียว: ลง texture / legs (มี gender = ... กำกับ)
        const f = e.gender === 'both' && set.g === 'female' ? 'F' : '';
        for (const [part, field] of [['upper', 'texture'], ['lower', 'legs']]) {
            if (set.parts.includes(part)) fields.push(`${field}${f} = '${fileOf(e, part, set)}'`);
            else if (f) fields.push(`${field}F = false`);
        }
    }
    // รูปในร้านรูปเดียวใช้ทั้งชายและหญิง (ชื่อไฟล์รูป = <ชื่อ>.png ไม่มี _mr / _fr) — ระบุไว้เสมอ
    // ไม่ระบุ ร้านจะหา img/<texture>.png ซึ่งตอนนี้ texture ลงท้าย _mr
    fields.push(`image = 'img/${e.name}.png'`);
    if (e.color) fields.push('color = true');
    if (e.gender !== 'both') fields.push(`gender = '${e.gender}'`);
    fields.push(`desc = ''`);
    $('eConfig').value = `{ ${fields.join(', ')} },`;
}

['eName', 'eLabel', 'ePrice', 'eCat', 'eGender', 'eRes'].forEach((id) => $(id).addEventListener('input', updateExport));
$('eGender').addEventListener('change', () => {
    const g = $('eGender').value;
    if (g !== 'both' && window.BodyView && S.gender !== g) BodyView.setGender(g);
});

/** ภาพลายของชิ้นนั้น (เพศ g) ที่ความละเอียด res — ลายบนภาพวาดจากรูปต้นฉบับ ลายติดบนตัวอบใหม่ที่ res */
function partImage(part, res, g = S.gender) {
    const c = canvasOf(res);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    for (const L of S.layers) {
        if (!L.visible || !forGender(L, g)) continue;
        if (onBody(L)) {
            ctx.drawImage(BodyView.bakeAt(L, part, res, g), 0, 0);
        } else {
            inGender(L, g, () => {
                if (partOf(L) !== part) return;
                ctx.save();
                ctx.scale(res / SIZE, res / SIZE);
                for (const [ox, oy] of offsets()) drawLayer(ctx, L, ox, oy);
                ctx.restore();
            });
        }
    }
    inkPost(ctx, res);
    return c;
}

function rgbaOf(c) {
    return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
}

function alphaOf(rgba) {
    const a = new Uint8Array(rgba.length / 4);
    for (let i = 0; i < a.length; i++) a[i] = rgba[i * 4 + 3];
    return a;
}

async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') throw new Error('เบราว์เซอร์นี้บีบอัดไม่ได้ ใช้ Chrome / Edge / Opera รุ่นใหม่');
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64Bytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

const nextFrame = () => new Promise((r) => setTimeout(r, 30));

$('btnYtd').addEventListener('click', async () => {
    const e = exportInfo();
    const btn = $('btnYtd');
    btn.disabled = true;
    try {
        const mips = Math.log2(e.res) + 1;                  // ถึง 1x1 แบบไฟล์เดิม (512 = 10 ชั้น)
        const ma = base64Bytes(window.PLACER_MATERIAL);
        const made = [];
        for (const set of e.sets) {
            for (const part of set.parts) {
                const file = fileOf(e, part, set);
                toast(`กำลังสร้าง ${file}.ytd (${e.res}×${e.res}) …`);
                await nextFrame();
                const rgba = rgbaOf(partImage(part, e.res, set.g));
                const ab = e.color
                    ? TattooYtd.buildAlbedoMipsRGBA(rgba, e.res, mips)
                    : TattooYtd.buildAlbedoMips(alphaOf(rgba), e.res, mips);
                const { header, body } = TattooYtd.buildYtd(file, ab, ma, null, { mips, w: e.res, h: e.res });
                const packed = await deflateRaw(body);
                download(file + '.ytd', new Blob([header, packed], { type: 'application/octet-stream' }));
                made.push(file + '.ytd');
                if (part === 'upper') {
                    // คู่แขนสลับ: ตอนใส่เสื้อ / ถุงมือ เกมใช้ท่อนบนที่แขนซ้าย-ขวาสลับกันบนภาพ (ดู swapArmHalves ใน ytd.js)
                    await nextFrame();
                    const sw = TattooYtd.buildYtd(file + '_sw', TattooYtd.swapArmHalves(ab, e.res, e.res, mips, 16), ma, null,
                        { mips, w: e.res, h: e.res });
                    download(file + '_sw.ytd', new Blob([sw.header, await deflateRaw(sw.body)], { type: 'application/octet-stream' }));
                    made.push(file + '_sw.ytd');
                }
            }
        }
        toast(`สร้าง ${made.join(' + ')} แล้ว`);
    } catch (err) {
        toast('สร้าง .ytd ไม่สำเร็จ: ' + err.message, true);
    } finally {
        if (window.BodyView) BodyView.releaseHiRes();
        btn.disabled = false;
    }
});

/** รูปในร้าน 256x256: รูปที่ใส่เอง (ย่อให้พอดี พื้นใส) หรือครอปส่วนที่มีลายจากภาพ UV */
$('btnThumb').addEventListener('click', async () => {
    const e = exportInfo();
    if (S.shot) {
        // รูปที่ใส่เอง: ตามที่จัดไว้ในช่องรูปในร้านเป๊ะ ๆ
        const c = canvasOf(SHOT);
        drawShotTo(c.getContext('2d'), SHOT);
        return download(e.name + '.png', c.toDataURL('image/png'));
    }
    let best = null;
    for (const part of e.parts) {
        const c = compose(part), d = rgbaOf(c);
        let x0 = SIZE, y0 = SIZE, x1 = -1, y1 = -1, n = 0;
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                if (d[(y * SIZE + x) * 4 + 3] > 12) {
                    n++;
                    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
            }
        }
        if (n && (!best || n > best.n)) best = { c, n, x0, y0, x1, y1 };
    }
    compose();
    if (!best) return toast('ยังไม่มีลายให้ทำรูป', true);
    const side = Math.max(best.x1 - best.x0 + 1, best.y1 - best.y0 + 1) * 1.12;
    const cx = (best.x0 + best.x1 + 1) / 2, cy = (best.y0 + best.y1 + 1) / 2;
    const c = canvasOf(256);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(best.c, cx - side / 2, cy - side / 2, side, side, 0, 0, 256, 256);
    grayShot(ctx, 256);
    download(e.name + '.png', c.toDataURL('image/png'));
});

/** _ab.png สำหรับแพ็คเองใน CodeX: หมึกเดียว = สีเขียว (0,125,0) + alpha แบบไฟล์เดิม · ลายสี = สีจริง */
$('btnAb').addEventListener('click', async () => {
    const e = exportInfo();
    try {
        for (const set of e.sets) for (const part of set.parts) {
            await nextFrame();
            const src = partImage(part, e.res, set.g);
            const c = canvasOf(e.res);
            const ctx = c.getContext('2d');
            if (e.color) {
                ctx.drawImage(src, 0, 0);
            } else {
                const a = alphaOf(rgbaOf(src));
                const im = ctx.createImageData(e.res, e.res);
                for (let i = 0; i < a.length; i++) { im.data[i * 4 + 1] = 125; im.data[i * 4 + 3] = a[i]; }
                ctx.putImageData(im, 0, 0);
            }
            download(fileOf(e, part, set) + '_ab.png', c.toDataURL('image/png'));
            if (part === 'upper') {
                // คู่แขนสลับ (<ชื่อ>_sw) — ครึ่งบนของภาพสลับซ้าย-ขวา
                const sw = canvasOf(e.res), sctx = sw.getContext('2d'), half = e.res / 2;
                sctx.drawImage(c, 0, half, e.res, half, 0, half, e.res, half);
                sctx.drawImage(c, 0, 0, half, half, half, 0, half, half);
                sctx.drawImage(c, half, 0, half, half, 0, 0, half, half);
                download(fileOf(e, part, set) + '_sw_ab.png', sw.toDataURL('image/png'));
            }
        }
    } finally {
        if (window.BodyView) BodyView.releaseHiRes();
    }
});

// ───────────────────────────────────────────── รูปในร้าน ──────────
// ช่องรูปในร้าน = กรอบ 256x256 เท่ารูปจริงในร้าน ลากเลื่อน / ล้อซูม ได้ภาพตามที่เห็นในกรอบ

const SHOT = 256;

const shotSize = (s) => [s.img.naturalWidth || s.img.width, s.img.naturalHeight || s.img.height];

/** รูปในร้านขาวดำ: แปลงสีทั้งภาพเป็นความสว่าง (alpha คงเดิม) */
function grayShot(ctx, size) {
    if (!S.shotGray) return;
    const im = ctx.getImageData(0, 0, size, size), d = im.data;
    for (let i = 0; i < d.length; i += 4) {
        const y = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
        d[i] = d[i + 1] = d[i + 2] = y;
    }
    ctx.putImageData(im, 0, 0);
}

/** วาดรูปในร้านตามที่จัดไว้ลง ctx ขนาด size x size (พื้นใส) */
function drawShotTo(ctx, size) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const s = S.shot;
    if (!s) return;
    const [w, h] = shotSize(s), k = size / SHOT;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(size / 2 + s.ox * k, size / 2 + s.oy * k);
    ctx.scale(s.zoom * k, s.zoom * k);
    ctx.drawImage(s.img, -w / 2, -h / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    grayShot(ctx, size);
}

/** ซูมที่รูปพอดีกรอบ (ทั้งรูปอยู่ในกรอบ) */
function shotFitZoom() {
    const [w, h] = shotSize(S.shot);
    return SHOT / Math.max(w, h);
}

function drawShot() {
    const c = $('shotCanvas');
    const css = c.clientWidth || 240;
    const px = Math.round(css * (window.devicePixelRatio || 1));
    if (c.width !== px) c.width = c.height = px;
    drawShotTo(c.getContext('2d'), px);
    if (S.shot) {
        const pct = Math.round(S.shot.zoom / shotFitZoom() * 100);
        $('shotZoom').value = clamp(pct, 10, 800);
        $('shotZoomV').textContent = pct + '%';
    }
}

/** ใส่รูปในร้าน (src = data URL) · view = { zoom, ox, oy } ที่จัดไว้ (ไม่มี = พอดีกรอบ) */
async function setShot(src, view) {
    if (!src) {
        S.shot = null;
    } else {
        const img = await loadImage(src);
        S.shot = { src, img, zoom: 1, ox: 0, oy: 0 };
        if (view && view.zoom) Object.assign(S.shot, view);
        else S.shot.zoom = shotFitZoom();
    }
    const on = !!S.shot;
    $('shotCanvas').classList.toggle('hidden', !on);
    $('shotEmpty').classList.toggle('hidden', on);
    $('shotTools').classList.toggle('hidden', !on);
    $('shotClear').disabled = !on;
    if (on) drawShot();
    updateExport();
}

function zoomShot(f, px = 0, py = 0) {
    const s = S.shot;
    const zoom = clamp(s.zoom * f, shotFitZoom() * 0.1, shotFitZoom() * 8);
    f = zoom / s.zoom;
    // ซูมเข้าหาจุดที่ชี้: จุดนั้นอยู่ที่เดิมในกรอบ
    s.ox = px - (px - s.ox) * f;
    s.oy = py - (py - s.oy) * f;
    s.zoom = zoom;
    drawShot();
}

function loadShotFile(f) {
    if (!f || !f.type.startsWith('image/')) return toast('ใช้ได้เฉพาะไฟล์รูป', true);
    const r = new FileReader();
    r.onload = () => setShot(r.result);
    r.readAsDataURL(f);
}

(function shotEditor() {
    const c = $('shotCanvas');
    let pan = null;
    const toShot = (e) => {
        const r = c.getBoundingClientRect();
        return [((e.clientX - r.left) / r.width - 0.5) * SHOT, ((e.clientY - r.top) / r.height - 0.5) * SHOT];
    };
    c.addEventListener('pointerdown', (e) => {
        if (!S.shot) return;
        c.setPointerCapture(e.pointerId);
        pan = { at: toShot(e), ox: S.shot.ox, oy: S.shot.oy };
    });
    c.addEventListener('pointermove', (e) => {
        if (!pan) return;
        const [x, y] = toShot(e);
        S.shot.ox = pan.ox + x - pan.at[0];
        S.shot.oy = pan.oy + y - pan.at[1];
        drawShot();
    });
    const end = () => { pan = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
        if (!S.shot) return;
        e.preventDefault();
        const [x, y] = toShot(e);
        zoomShot(Math.exp(-(e.deltaY || e.deltaX) * 0.0015), x, y);
    }, { passive: false });
    c.addEventListener('dblclick', () => { if (S.shot) { S.shot.zoom = shotFitZoom(); S.shot.ox = S.shot.oy = 0; drawShot(); } });
})();

$('shotZoom').addEventListener('input', (e) => {
    if (S.shot) zoomShot(shotFitZoom() * Number(e.target.value) / 100 / S.shot.zoom);
});
$('shotFit').addEventListener('click', () => {
    if (!S.shot) return;
    Object.assign(S.shot, { zoom: shotFitZoom(), ox: 0, oy: 0 });
    drawShot();
});
$('shotFill').addEventListener('click', () => {
    if (!S.shot) return;
    const [w, h] = shotSize(S.shot);
    Object.assign(S.shot, { zoom: SHOT / Math.min(w, h), ox: 0, oy: 0 });
    drawShot();
});
$('shotPick').addEventListener('click', () => $('fileShot').click());
$('fileShot').addEventListener('change', (e) => { loadShotFile(e.target.files[0]); e.target.value = ''; });
$('shotClear').addEventListener('click', () => setShot(null));
$('shotGray').addEventListener('change', (e) => { S.shotGray = e.target.checked; if (S.shot) drawShot(); });
$('shotEmpty').addEventListener('click', () => $('fileShot').click());
['dragenter', 'dragover'].forEach((ev) => $('shotBox').addEventListener(ev, (e) => { e.preventDefault(); $('shotBox').classList.add('drop'); }));
['dragleave', 'drop'].forEach((ev) => $('shotBox').addEventListener(ev, (e) => { e.preventDefault(); $('shotBox').classList.remove('drop'); }));
$('shotBox').addEventListener('drop', (e) => loadShotFile(e.dataTransfer.files[0]));

// ── ถ่ายจากตัว 3D: มีกรอบให้เห็นก่อนว่ารูปจะได้แค่ไหน จัดกล้องจนพอใจแล้วค่อยถ่าย

let capture = null;

function layoutCapture() {
    if (!capture) return;
    const wrap = $('bodyWrap');
    const side = Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight - 110) * 0.86);
    $('captureBox').style.width = $('captureBox').style.height = Math.max(80, side) + 'px';
}

function startCapture() {
    if (!window.BodyView) return;
    if ($('stageBody').dataset.layout === 'uv') BodyView.setLayout('both');
    // ระหว่างจัดมุม ซ่อนกรอบลาย / เส้นไกด์ ให้เห็นเหมือนรูปที่จะได้
    capture = { outline: $('bodyOutline').checked, guide: $('uvGuide').checked };
    for (const id of ['bodyOutline', 'uvGuide']) {
        $(id).checked = false;
        $(id).dispatchEvent(new Event('change'));
    }
    $('captureFrame').classList.remove('hidden');
    layoutCapture();
}

function endCapture() {
    if (!capture) return;
    $('captureFrame').classList.add('hidden');
    $('bodyOutline').checked = capture.outline;
    $('uvGuide').checked = capture.guide;
    for (const id of ['bodyOutline', 'uvGuide']) $(id).dispatchEvent(new Event('change'));
    capture = null;
}

function takeCapture() {
    const snap = BodyView.snapshot();
    if (!snap) return toast('เปิดมุมมองตัว 3D ก่อน', true);
    const cv = $('body3d').getBoundingClientRect(), box = $('captureBox').getBoundingClientRect();
    const k = snap.width / cv.width;
    const side = Math.round(box.width * k);
    const c = canvasOf(side);
    c.getContext('2d').drawImage(snap, (box.left - cv.left) * k, (box.top - cv.top) * k, box.width * k, box.height * k, 0, 0, side, side);
    endCapture();
    setShot(c.toDataURL('image/png'), { zoom: SHOT / side, ox: 0, oy: 0 });
    $('shotBox').scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast('ถ่ายแล้ว — ลาก / ซูมในช่องรูปในร้านเพื่อจัดต่อได้');
}

$('shot3d').addEventListener('click', startCapture);
$('captureTake').addEventListener('click', takeCapture);
$('captureCancel').addEventListener('click', endCapture);
window.addEventListener('keydown', (e) => { if (capture && e.key === 'Escape') endCapture(); });
new ResizeObserver(layoutCapture).observe($('bodyWrap'));

$('btnCopy').addEventListener('click', async () => {
    const text = $('eConfig').value;
    try {
        await navigator.clipboard.writeText(text);
    } catch (_) {
        $('eConfig').select();
        document.execCommand('copy');
    }
    toast('คัดลอกแล้ว');
});

// ───────────────────────────────────────────── project ───────────

const SAVED = ['name', 'src', 'x', 'y', 'part', 'scale', 'sx', 'sy', 'rot', 'flipX', 'flipY', 'mode', 'threshold', 'gain', 'invert', 'color', 'visible', 'place', 'view', 'poses', 'only'];

/** สถานะทั้งหมดเป็น object (ไฟล์โปรเจกต์ / งานที่บันทึกอัตโนมัติ) */
function projectData() {
    const e = exportInfo();
    return {
        version: 2,
        wrapX: S.wrapX, wrapY: S.wrapY, gender: S.gender,
        export: Object.assign({}, e, {
            sets: undefined,
            shot: S.shot ? { src: S.shot.src, zoom: S.shot.zoom, ox: S.shot.ox, oy: S.shot.oy } : null,
            shotGray: !!S.shotGray,
            inkThick: S.inkThick, inkSharp: S.inkSharp,
        }),
        layers: S.layers.map((L) => Object.assign(Object.fromEntries(SAVED.map((k) => [k, L[k]])),
            L.erase ? { erase: L.erase.toDataURL('image/png') } : {})),
    };
}

$('btnSave').addEventListener('click', () => {
    const data = projectData();
    download((data.export.name || 'tattoo') + '.placer.json', new Blob([JSON.stringify(data)], { type: 'application/json' }));
});

$('btnOpen').addEventListener('click', () => $('fileProject').click());
/** เปิดโปรเจกต์จาก object (ไฟล์ .placer.json หรืองานที่บันทึกอัตโนมัติ) */
async function loadProject(data) {
    Draft.pause(true);
    try {
        S.layers = [];
        S.sel = null;
        S.wrapX = data.wrapX !== false;
        S.wrapY = !!data.wrapY;
        $('wrapX').checked = S.wrapX;
        $('wrapY').checked = S.wrapY;
        // ตำแหน่งในไฟล์เป็นตำแหน่งบนภาพของเพศที่บันทึกไว้ — สลับเพศก่อนใส่เลเยอร์
        if (data.gender && window.BodyView) BodyView.setGender(data.gender);
        for (const l of data.layers || []) {
            // โปรเจกต์เก่า: วางบนภาพท่อนบน หมึกเดียว ไม่ยืด
            const opts = Object.assign({ place: 'uv', part: 'upper', sx: 1, sy: 1, color: false }, l,
                { erase: null, poses: clonePoses(l.poses), noHistory: true });
            const L = await addLayer(l.src, opts);
            if (l.erase) {
                const img = await loadImage(l.erase);
                L.erase = canvasOf(L.w, L.h);
                L.erase.getContext('2d').drawImage(img, 0, 0, L.w, L.h);
                applyErase(L);
            }
        }
        history.undo.length = 0;
        history.redo.length = 0;
        updateUndoButtons();
        if (data.export) {
            const x = data.export;
            $('eName').value = x.name || '';
            $('eLabel').value = x.label || '';
            $('ePrice').value = x.price ?? 50;
            $('eCat').value = x.category || 'medium';
            $('eGender').value = x.gender || 'both';
            $('eRes').value = String(x.res || SIZE);
            S.shotGray = !!x.shotGray;
            $('shotGray').checked = S.shotGray;
            S.inkThick = Number(x.inkThick) || 0;
            S.inkSharp = Number(x.inkSharp) || 0;
            $('inkThick').value = String(S.inkThick);
            $('inkSharp').value = String(Math.round(S.inkSharp * 100));
            $('inkSharpV').textContent = Math.round(S.inkSharp * 100) + '%';
            const sh = x.shot;
            await setShot(sh && (sh.src || sh), sh && sh.src ? { zoom: sh.zoom, ox: sh.ox, oy: sh.oy } : null);
        }
        refreshAll();
    } finally {
        Draft.pause(false);
    }
}

$('fileProject').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
        await loadProject(JSON.parse(await f.text()));
        toast('เปิดโปรเจกต์แล้ว');
    } catch (err) {
        toast('เปิดโปรเจกต์ไม่ได้: ' + err.message, true);
    }
});

// ───────────────────────────────────────────── บันทึกอัตโนมัติ ──
// เก็บงานล่าสุดไว้ในเบราว์เซอร์ (IndexedDB) ทุกครั้งที่แก้ — refresh / ปิดหน้าไปแล้วกู้คืนได้
// ช่อง 'draft' = งานตอนนี้ · 'previous' = งานของรอบก่อนที่เปิด Tool (เสนอให้กู้คืนตอนเริ่ม งานใหม่ไม่ทับ)
// เบราว์เซอร์ไม่ให้ใช้ (โหมดส่วนตัว ฯลฯ) = ปิดเงียบ ๆ Tool ใช้ได้ตามปกติ

const Draft = (() => {
    let paused = false, lastSig = '', busy = false, timer = 0;

    function store(mode, fn) {
        return new Promise((resolve, reject) => {
            let req;
            try { req = indexedDB.open('phutorn_placer', 1); } catch (err) { reject(err); return; }
            req.onupgradeneeded = () => req.result.createObjectStore('kv');
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction('kv', mode);
                const r = fn(tx.objectStore('kv'));
                tx.oncomplete = () => { db.close(); resolve(r && r.result); };
                tx.onerror = () => { db.close(); reject(tx.error); };
            };
        });
    }
    const get = (k) => store('readonly', (s) => s.get(k));
    const put = (k, v) => store('readwrite', (s) => s.put(v, k));
    const del = (k) => store('readwrite', (s) => s.delete(k));

    /** ลายนิ้วมือของงาน — เปลี่ยนเมื่อแก้อะไรก็ตามที่บันทึกในโปรเจกต์ */
    function signature() {
        return JSON.stringify([
            S.wrapX, S.wrapY, S.gender, S.inkThick, S.inkSharp, S.shotGray,
            S.shot ? [S.shot.src.length, S.shot.zoom, S.shot.ox, S.shot.oy] : 0,
            ['eName', 'eLabel', 'ePrice', 'eCat', 'eGender', 'eRes'].map((id) => $(id).value),
            S.layers.map((L) => [
                SAVED.map((k) => (k === 'src' ? L.src.length : k === 'poses' ? JSON.stringify(L.poses) : L[k])),
                L.erase ? L.eraseVer : 0,
            ]),
        ]);
    }

    async function tick() {
        if (paused || busy) return;
        const sig = signature();
        if (sig === lastSig) return;
        lastSig = sig;
        busy = true;
        try {
            if (!S.layers.length && !$('eName').value.trim()) await del('draft');
            else await put('draft', { at: Date.now(), data: projectData() });
        } catch (err) {
            clearInterval(timer);                       // เบราว์เซอร์ไม่ให้เก็บ — เลิกลอง
        } finally {
            busy = false;
        }
    }

    function offer(prev) {
        const n = (prev.data.layers || []).length;
        const name = prev.data.export && prev.data.export.name;
        const when = new Date(prev.at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
        $('draftText').textContent = `มีงานล่าสุดที่ยังไม่ได้บันทึกเป็นไฟล์ (${when} · ${n} เลเยอร์${name ? ' · ' + name : ''})`;
        $('draftBar').classList.remove('hidden');
        $('draftRestore').onclick = async () => {
            $('draftBar').classList.add('hidden');
            try {
                await loadProject(prev.data);
                toast('กู้คืนงานแล้ว');
            } catch (err) {
                toast('กู้คืนไม่ได้: ' + err.message, true);
            }
        };
        $('draftDiscard').onclick = async () => {
            $('draftBar').classList.add('hidden');
            try { await del('previous'); } catch (err) { /* ไม่เป็นไร */ }
        };
    }

    async function start() {
        let prev = null;
        try {
            // งานของรอบก่อน → ช่อง previous (งานรอบนี้เขียน draft ได้โดยของเก่าไม่หาย)
            const draft = await get('draft');
            if (draft && draft.data && (draft.data.layers || []).length) {
                await put('previous', draft);
                await del('draft');
            }
            prev = await get('previous');
        } catch (err) {
            return;                                     // ใช้ IndexedDB ไม่ได้
        }
        lastSig = signature();
        timer = setInterval(tick, 1500);
        if (prev && prev.data && (prev.data.layers || []).length) offer(prev);
    }

    return {
        start,
        pause(on) { paused = on; },
    };
})();

// ───────────────────────────────────────────── start ─────────────

(async function init() {
    const pick = $('refPick');
    for (const r of window.PLACER_REFS || []) {
        refs[r.name] = await loadImage(r.url);
        const o = document.createElement('option');
        o.value = r.name;
        o.textContent = r.name.replace(/^overlay_hand_/, '');
        pick.appendChild(o);
    }
    buildSteppers();
    layoutView();
    refreshAll();
    Draft.start();
})();
