/* =====================================================================
   ตัวละคร 3D — เห็นลายบนตัวจริงระหว่างวาง + ไกด์ชิ้นผิว (UV) บนภาพ 2D
   + ลายแบบ "ติดบนตัว" : ฉายรูปลงผิว 3D แล้วอบกลับเป็นภาพ UV เอง ลายจึงต่อข้ามรอยต่อชิ้นให้อัตโนมัติ

   ผิวที่สักได้ 2 ชิ้น (แต่ละชิ้นมีภาพ UV 512 ของตัวเอง ส่งออกเป็นคนละ .ytd):
     upper = bodies_upper (ลำตัว แขน มือ)    lower = bodies_lower (สะโพก ขา เท้า)
   หัว/คอ (heads) ผิวถูก murphy สร้าง — ลายลงไม่ได้ ใช้แค่บังแสง/บังการฉาย

   โมเดล/ผิวมาจาก model.js (สร้างด้วย build_model.py) ไม่มีไฟล์นี้ Tool ก็ใช้แค่ภาพ UV ได้ตามเดิม
   WebGL เขียนเอง ไม่ใช้ library — เปิดไฟล์ตรง ๆ ได้ ไม่ต้องมี server / เน็ต
   ใช้ตัวแปรของ placer.js (S, compose, refs, selected, corners, offsets, render ...)
   ===================================================================== */
'use strict';

window.BodyView = (function () {
    const DATA = window.PLACER_BODY;
    if (!DATA) {
        document.querySelectorAll('.needs-body').forEach((el) => el.classList.add('hidden'));
        $('stageBody').dataset.layout = 'uv';
        return null;
    }

    const PARTS = ['upper', 'lower', 'head'];
    const PAINTABLE = ['upper', 'lower'];
    const PART_NAME = { upper: 'ท่อนบน', lower: 'ขา' };
    const FOV = 32 * Math.PI / 180;
    const FRONT = 0;                             // ตัวละครหันไปทาง +z (แกน -y ในเกม)
    const VIEWS = {
        front: { yaw: FRONT, pitch: 0.06 },
        back:  { yaw: Math.PI, pitch: 0.06 },
        left:  { yaw: Math.PI / 2, pitch: 0.06 },    // ด้านซ้ายของตัวละคร (แกน +x)
        right: { yaw: -Math.PI / 2, pitch: 0.06 },
    };
    const SEAM = '#3d8fd1';                      // รอยต่อชิ้น — ลายต้องไปต่อที่ชิ้นอื่น
    const BORDER = '#e0603f';                    // สุดโมเดล (คอ / เอว / ข้อเท้า) — ลายเลยไปหาย
    const PICKED = [230, 0, 122];                // กรอบลายติดบนตัวที่เลือก
    const REF_TINT = '#2f7fc1';
    const FALLBACK_SKIN = '#b98d6c';
    const SKIN_SELECT = { upper: 'skinUpper', lower: 'skinLower', head: 'skinHead' };

    // ───────────────────────────────────────── คณิต ────────────────

    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
    const neg = (a) => [-a[0], -a[1], -a[2]];
    const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

    /** ค่า/เวกเตอร์ลักษณะเฉพาะของเมทริกซ์สมมาตร 3x3 (Jacobi) เรียงจากน้อยไปมาก */
    function eigen3(m) {
        const A = m.map((r) => r.slice());
        const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        for (let sweep = 0; sweep < 12; sweep++) {
            for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
                if (Math.abs(A[p][q]) < 1e-12) continue;
                const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
                const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
                const c = 1 / Math.sqrt(t * t + 1), s = t * c;
                for (let k = 0; k < 3; k++) {
                    const akp = A[k][p], akq = A[k][q];
                    A[k][p] = c * akp - s * akq;
                    A[k][q] = s * akp + c * akq;
                }
                for (let k = 0; k < 3; k++) {
                    const apk = A[p][k], aqk = A[q][k];
                    A[p][k] = c * apk - s * aqk;
                    A[q][k] = s * apk + c * aqk;
                }
                for (let k = 0; k < 3; k++) {
                    const vkp = V[k][p], vkq = V[k][q];
                    V[k][p] = c * vkp - s * vkq;
                    V[k][q] = s * vkp + c * vkq;
                }
            }
        }
        return [0, 1, 2]
            .map((i) => ({ value: A[i][i], vector: [V[0][i], V[1][i], V[2][i]] }))
            .sort((a, b) => a.value - b.value);
    }

    // ───────────────────────────────────────── ข้อมูลโมเดล ─────────

    function bytes(b64) {
        const bin = atob(b64);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return u.buffer;
    }

    const meshes = {};
    const skinSel = {};          // gender → part → ชื่อผิวที่เลือก

    /** ชิ้นส่วนของเพศนั้น { upper, lower, head } (ถอดจาก base64 ตอนใช้ครั้งแรก) */
    function body(g) {
        if (meshes[g]) return meshes[g];
        const out = {};
        skinSel[g] = skinSel[g] || {};
        for (const name of PARTS) {
            const d = DATA[g] && DATA[g][name];
            if (!d) continue;
            const m = {
                name,
                pos: new Float32Array(bytes(d.pos)),
                nrm: new Float32Array(bytes(d.nrm)),
                uv: new Float32Array(bytes(d.uv)),
                idx: Uint16Array.from(new Uint32Array(bytes(d.idx))),
                seams: d.seams ? new Float32Array(bytes(d.seams)) : null,
                borders: d.borders ? new Float32Array(bytes(d.borders)) : null,
                skins: (d.skins || []).map((s) => ({ name: s.name, url: s.url, img: null, ready: false })),
                gl: null,
                min: [Infinity, Infinity, Infinity],
                max: [-Infinity, -Infinity, -Infinity],
            };
            for (let i = 0; i < m.pos.length; i += 3) {
                for (let k = 0; k < 3; k++) {
                    m.min[k] = Math.min(m.min[k], m.pos[i + k]);
                    m.max[k] = Math.max(m.max[k], m.pos[i + k]);
                }
            }
            m.wraps = m.uv.some((v, i) => !(i & 1) && v > 1);   // มือตัวผู้หญิงใช้ u เกิน 1 (วนกลับมาภาพเดิม)
            if (!skinSel[g][name]) skinSel[g][name] = d.skin || (m.skins[0] && m.skins[0].name) || '';
            out[name] = m;
        }
        return (meshes[g] = out);
    }

    /** รูปผิวที่เลือกของชิ้นนั้น (null = ไม่มี / ยังโหลดไม่เสร็จ — เสร็จแล้วจะวาดใหม่เอง) */
    function skinOf(g, part) {
        const m = body(g)[part];
        const s = m && m.skins.find((x) => x.name === skinSel[g][part]);
        if (!s) return null;
        if (!s.img && s.url) {
            s.img = new Image();
            s.img.onload = () => { s.ready = true; skinChanged(g, part); };
            s.img.src = s.url;
        }
        return s.ready ? s.img : null;
    }

    // ───────────────────────────────────────── ไกด์ชิ้นผิว ─────────

    /** ระบายพื้นที่ที่โมเดลใช้จริงบน texture (สีขาวบนพื้นใส) */
    function uvMask(m, size) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const p = new Path2D();
        const { uv, idx } = m;
        for (let i = 0; i < idx.length; i += 3) {
            const a = idx[i] * 2;
            let b = idx[i + 1] * 2, d = idx[i + 2] * 2;
            // หมุนทุกสามเหลี่ยมไปทางเดียวกัน ไม่งั้นชิ้นที่ทับกันจะหักล้างเป็นรู
            if ((uv[b] - uv[a]) * (uv[d + 1] - uv[a + 1]) - (uv[d] - uv[a]) * (uv[b + 1] - uv[a + 1]) < 0) [b, d] = [d, b];
            p.moveTo(uv[a] * size, uv[a + 1] * size);
            p.lineTo(uv[b] * size, uv[b + 1] * size);
            p.lineTo(uv[d] * size, uv[d + 1] * size);
            p.closePath();
        }
        ctx.fillStyle = ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        for (const ox of m.wraps ? [0, -size] : [0]) {
            ctx.setTransform(1, 0, 0, 1, ox, 0);
            ctx.fill(p);
            ctx.stroke(p);
        }
        return c;
    }

    function edgePath(e) {
        const p = new Path2D();
        if (!e) return p;
        for (let i = 0; i < e.length; i += 4) {
            p.moveTo(e[i] * SIZE, e[i + 1] * SIZE);
            p.lineTo(e[i + 2] * SIZE, e[i + 3] * SIZE);
        }
        return p;
    }

    const guides = {};

    /** ไกด์บนภาพ UV: พื้นที่ที่ไม่ใช่ผิว (ทำมืด) + เส้นขอบชิ้น */
    function guide(g, part) {
        const id = g + ':' + part;
        if (guides[id]) return guides[id];
        const m = body(g)[part];
        if (!m) return null;
        const dead = canvas512();
        const d = dead.getContext('2d');
        d.fillStyle = 'rgba(18, 18, 18, 0.6)';
        d.fillRect(0, 0, SIZE, SIZE);
        d.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        d.lineWidth = 1;
        d.beginPath();
        for (let i = -SIZE; i < SIZE; i += 9) { d.moveTo(i, 0); d.lineTo(i + SIZE, SIZE); }
        d.stroke();
        d.globalCompositeOperation = 'destination-out';
        d.drawImage(uvMask(m, SIZE), 0, 0);
        return (guides[id] = { dead, seams: edgePath(m.seams), borders: edgePath(m.borders), wraps: m.wraps });
    }

    function strokeEdges(ctx, G, width) {
        const shifts = G.wraps ? [0, -SIZE] : [0];
        ctx.lineWidth = width;
        for (const sx of shifts) {
            ctx.save();
            ctx.translate(sx, 0);
            ctx.strokeStyle = SEAM;
            ctx.stroke(G.seams);
            ctx.strokeStyle = BORDER;
            ctx.lineWidth = width * 1.8;
            ctx.stroke(G.borders);
            ctx.restore();
        }
    }

    /** เรียกจาก render() ของ placer.js หลังวาดลายแล้ว (ctx อยู่ในหน่วยพิกเซลของภาพ) */
    function drawUvGuide(ctx, K) {
        const G = guide(S.gender, S.uvPart);
        if (!G) return;
        const tiles = [[0, 0, 1]];
        if (S.tile) for (const [ox, oy] of offsets()) if (ox || oy) tiles.push([ox, oy, 0.4]);
        for (const [ox, oy, alpha] of tiles) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(ox, oy, SIZE, SIZE);
            ctx.clip();
            ctx.translate(ox, oy);
            ctx.globalAlpha = alpha;
            ctx.drawImage(G.dead, 0, 0);
            strokeEdges(ctx, G, 1.1 / K);
            ctx.restore();
        }
    }

    // ───────────────────────────────────────── พิกเซลบนภาพ → จุดบนตัว ─

    const surfaces = {};

    /** ทุกพิกเซลของภาพ UV ของชิ้นนั้นรู้ว่าอยู่ตรงไหนบนตัว (ตำแหน่ง + ทิศผิว + สามเหลี่ยม)
     *  size = ความละเอียดภาพ (512 ตอนแก้ไข / 1024-2048 ตอนส่งออก)
     *  cov: 0 = ไม่ใช่ผิว · 1 = ผิวจริง · 2+ = ขอบที่ขยายออกไป (กันรอยขาดตอนเกมย่อ texture) */
    function surface(g, part, size = SIZE) {
        const id = g + ':' + part + ':' + size;
        if (surfaces[id]) return surfaces[id];
        const m = body(g)[part];
        const N = size * size;
        const pos = new Float32Array(N * 3), nrm = new Float32Array(N * 3), cov = new Uint8Array(N);
        const tri = new Int32Array(N).fill(-1);                 // สามเหลี่ยมที่พิกเซลนี้อยู่
        const { uv, idx } = m, P = m.pos, Nm = m.nrm;
        let scaleSum = 0, areaSum = 0;

        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t], b = idx[t + 1], c = idx[t + 2];
            const x0 = uv[a * 2] * size, y0 = uv[a * 2 + 1] * size;
            const x1 = uv[b * 2] * size, y1 = uv[b * 2 + 1] * size;
            const x2 = uv[c * 2] * size, y2 = uv[c * 2 + 1] * size;
            const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
            if (Math.abs(area) < 1e-9) continue;

            // ขนาดจริงของ 1 พิกเซล (เฉลี่ยถ่วงตามพื้นที่)
            const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
            const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
            const area3 = Math.hypot(...cross(e1, e2)) / 2;
            scaleSum += Math.sqrt(area3 / (Math.abs(area) / 2)) * area3;
            areaSum += area3;

            for (const ox of Math.max(x0, x1, x2) > size ? [0, -size] : [0]) {
                const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2) + ox));
                const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2) + ox));
                const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
                const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
                for (let y = minY; y <= maxY; y++) {
                    const py = y + 0.5;
                    for (let x = minX; x <= maxX; x++) {
                        const px = x + 0.5 - ox;
                        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
                        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
                        const w2 = 1 - w0 - w1;
                        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
                        const i = y * size + x, o = i * 3;
                        for (let k = 0; k < 3; k++) {
                            pos[o + k] = w0 * P[a * 3 + k] + w1 * P[b * 3 + k] + w2 * P[c * 3 + k];
                        }
                        const nx = w0 * Nm[a * 3] + w1 * Nm[b * 3] + w2 * Nm[c * 3];
                        const ny = w0 * Nm[a * 3 + 1] + w1 * Nm[b * 3 + 1] + w2 * Nm[c * 3 + 1];
                        const nz = w0 * Nm[a * 3 + 2] + w1 * Nm[b * 3 + 2] + w2 * Nm[c * 3 + 2];
                        const l = Math.hypot(nx, ny, nz) || 1;
                        nrm[o] = nx / l; nrm[o + 1] = ny / l; nrm[o + 2] = nz / l;
                        cov[i] = 1;
                        tri[i] = t / 3;
                    }
                }
            }
        }

        // ขยายขอบชิ้นออกไป (~3 พิกเซลที่ 512) — ในเกม texture ถูกย่อ/เกลี่ย ถ้าหมึกจบพอดีขอบจะเห็นรอยขาด
        const pad = Math.max(3, Math.round(3 * size / SIZE));
        let front = [];
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const i = y * size + x;
                if (cov[i] && ((x > 0 && !cov[i - 1]) || (x < size - 1 && !cov[i + 1])
                    || (y > 0 && !cov[i - size]) || (y < size - 1 && !cov[i + size]))) front.push(i);
            }
        }
        for (let pass = 1; pass <= pad && front.length; pass++) {
            const next = [];
            for (const j of front) {
                const x = j % size, y = (j / size) | 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx, ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                        const i = ny * size + nx;
                        if (cov[i]) continue;
                        for (let q = 0; q < 3; q++) { pos[i * 3 + q] = pos[j * 3 + q]; nrm[i * 3 + q] = nrm[j * 3 + q]; }
                        cov[i] = Math.min(255, pass + 1);
                        tri[i] = tri[j];
                        next.push(i);
                    }
                }
            }
            front = next;
        }

        return (surfaces[id] = { size, pos, nrm, cov, tri, island: islands(m), mpp: areaSum ? scaleSum / areaSum : 0.002 });
    }

    // ───────────────────────────────────────── ยิงเส้นใส่ตัว ───────

    /** จุดแรกที่เส้น o + t·d ชน mesh → { m, i, u, v, t } */
    function cast(m, o, d) {
        const P = m.pos, I = m.idx;
        let best = null, bestT = Infinity;
        for (let i = 0; i < I.length; i += 3) {
            const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
            const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
            const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
            const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
            const det = e1x * px + e1y * py + e1z * pz;
            if (det > -1e-12 && det < 1e-12) continue;
            const inv = 1 / det;
            const sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
            const u = (sx * px + sy * py + sz * pz) * inv;
            if (u < 0 || u > 1) continue;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
            if (v < 0 || u + v > 1) continue;
            const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
            if (t > 1e-5 && t < bestT) { bestT = t; best = { m, i, u, v, t }; }
        }
        return best;
    }

    /** รายละเอียดจุดที่ชน: ชิ้น, ตำแหน่ง, ทิศผิว, ตำแหน่งบนภาพของชิ้นนั้น (px, py) */
    function hitInfo(h, o, d, g) {
        const { m, i } = h, I = m.idx, w0 = 1 - h.u - h.v;
        const a = I[i], b = I[i + 1], c = I[i + 2];
        const lerp = (A, n, k) => w0 * A[a * n + k] + h.u * A[b * n + k] + h.v * A[c * n + k];
        const out = {
            g,
            t: h.t,
            part: m.name,
            paint: PAINTABLE.includes(m.name),
            p: add(o, d, h.t),
            n: norm([lerp(m.nrm, 3, 0), lerp(m.nrm, 3, 1), lerp(m.nrm, 3, 2)]),
        };
        if (out.paint) {
            out.px = mod(lerp(m.uv, 2, 0), 1) * SIZE;
            out.py = lerp(m.uv, 2, 1) * SIZE;
        }
        return out;
    }

    /** จุดแรกที่ชนตัวของเพศ g (ทุกชิ้นรวมหัว — หัวบังได้แต่ลงลายไม่ได้) */
    function castBody(o, d, g = S.gender) {
        const B = body(g);
        let best = null;
        for (const name of PARTS) {
            if (!B[name]) continue;
            const h = cast(B[name], o, d);
            if (h && (!best || h.t < best.t)) best = h;
        }
        return best ? hitInfo(best, o, d, g) : null;
    }

    /** ทิศผิวเฉลี่ยรอบจุด p (เกลี่ยไม่ให้ลายสั่นตามรอยหยักของ mesh) */
    function smoothNormal(m, p, radius, fallback) {
        const P = m.pos, Nm = m.nrm, r2 = radius * radius;
        let x = 0, y = 0, z = 0;
        for (let i = 0; i < P.length; i += 3) {
            const dx = P[i] - p[0], dy = P[i + 1] - p[1], dz = P[i + 2] - p[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > r2) continue;
            if (Nm[i] * fallback[0] + Nm[i + 1] * fallback[1] + Nm[i + 2] * fallback[2] < 0) continue;   // อีกฝั่งของแขน/นิ้ว
            const w = 1 - d2 / r2;
            x += Nm[i] * w; y += Nm[i + 1] * w; z += Nm[i + 2] * w;
        }
        const l = Math.hypot(x, y, z);
        return l > 1e-6 ? [x / l, y / l, z / l] : fallback;
    }

    /** แกนของรูปบนผิว: T = ขวา, U = ขึ้น (มองจากนอกตัว) */
    function tangentFrame(n) {
        const ref = Math.abs(n[1]) > 0.92 ? [0, 0, 1] : [0, 1, 0];
        const k = dot(ref, n);
        const U = norm([ref[0] - n[0] * k, ref[1] - n[1] * k, ref[2] - n[2] * k]);
        return { T: cross(U, n), U };
    }

    // ───────────────────────────────────────── ลายติดบนตัว ─────────

    const partOf = (L) => (L.part === 'lower' ? 'lower' : 'upper');

    /** พิกเซลผิวจริงที่ใกล้ (x, y) ที่สุด */
    function anchorTexel(M, x, y) {
        const n = M.size, k = n / SIZE;
        const cx = Math.floor(mod(x * k, n)), cy = clamp(Math.floor(y * k), 0, n - 1);
        if (M.cov[cy * n + cx] === 1) return cy * n + cx;
        for (let r = 1; r <= 64; r++) {
            let best = -1, bd = Infinity;
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    const xx = mod(cx + dx, n), yy = cy + dy;
                    if (yy < 0 || yy >= n || M.cov[yy * n + xx] !== 1) continue;
                    if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = yy * n + xx; }
                }
            }
            if (best >= 0) return best;
        }
        return -1;
    }

    /** ตำแหน่ง/ทิศของลายบนตัว: จุดกลาง = (L.x, L.y) บนภาพของชิ้น L.part */
    function layerFrame(L) {
        const part = partOf(L);
        const M = surface(S.gender, part), m = body(S.gender)[part];
        const ti = anchorTexel(M, L.x, L.y);
        if (ti < 0) return null;
        const p = [M.pos[ti * 3], M.pos[ti * 3 + 1], M.pos[ti * 3 + 2]];
        const s = L.scale * M.mpp;                              // เมตรต่อพิกเซลของรูปลาย
        const span = Math.max(L.w * L.sx, L.h * L.sy) * s;
        let n, axes;
        if (L.place === 'view' && L.view) {
            // ฉายจากมุมกล้องที่บันทึกไว้: ทิศฉาย = ทิศกล้อง, ด้านบนของรูป = ด้านบนของจอ
            n = norm(L.view.n);
            const k = dot(L.view.up, n);
            const U = norm([L.view.up[0] - n[0] * k, L.view.up[1] - n[1] * k, L.view.up[2] - n[2] * k]);
            axes = { T: cross(U, n), U };
        } else {
            n = smoothNormal(m, p, clamp(span * 0.3, 0.015, 0.09), [M.nrm[ti * 3], M.nrm[ti * 3 + 1], M.nrm[ti * 3 + 2]]);
            axes = tangentFrame(n);
        }
        const F = Object.assign({ p, n, s, span, part, tri: M.tri[ti] }, axes);
        if (L.place === 'wrap') wrapFrame(F, m);
        return F;
    }

    /** ห่อรอบ: หารัศมีของแขน/ขา/ลำตัวตรงนั้น และแกนของมัน */
    function wrapFrame(F, m) {
        const through = cast(m, add(F.p, F.n, -0.002), neg(F.n));
        const r = clamp(through ? through.t / 2 : 0.06, 0.02, 0.25);
        const c0 = add(F.p, F.n, -r);

        // แกน = ทิศที่ผิวรอบ ๆ ตั้งฉากด้วยมากที่สุด (normal ของทรงกระบอกตั้งฉากกับแกนเสมอ)
        const R2 = Math.pow(Math.max(r * 1.6, 0.05), 2);
        const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        const P = m.pos, Nm = m.nrm;
        for (let i = 0; i < P.length; i += 3) {
            const dx = P[i] - c0[0], dy = P[i + 1] - c0[1], dz = P[i + 2] - c0[2];
            if (dx * dx + dy * dy + dz * dz > R2) continue;
            const n = [Nm[i], Nm[i + 1], Nm[i + 2]];
            for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += n[a] * n[b];
        }
        const e = eigen3(C);
        let A = e[1].value > 0 && e[0].value < e[1].value * 0.35 ? norm(e[0].vector) : F.U;
        if (dot(A, F.U) < 0) A = neg(A);
        const N = norm(add(F.n, A, -dot(F.n, A)));
        F.wrap = { r, A, N, R: cross(A, N), c: add(F.p, N, -r) };
    }

    /** รูปลายย่อให้ใกล้ขนาดจริงบนภาพ (ย่อทีละครึ่ง) — อ่านค่าเร็วและไม่แตกตอนลายเล็ก
     *  ลายสีเก็บสีไว้ด้วย */
    function layerPixels(L, size = SIZE) {
        const want = L.scale * Math.max(L.sx, L.sy) * 1.5 * size / SIZE;
        const k = Math.min(1, Math.pow(2, Math.round(Math.log2(Math.max(0.01, want)))));
        const ver = L.maskVer || 0;
        if (L.mip && L.mip.k === k && L.mip.ver === ver && L.mip.mask === L.mask && L.mip.color === !!L.color) return L.mip;
        const w = Math.max(1, Math.round(L.w * k)), h = Math.max(1, Math.round(L.h * k));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(L.mask, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        const a = new Uint8Array(w * h);
        for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
        const out = { k, ver, mask: L.mask, color: !!L.color, w, h, kx: w / L.w, ky: h / L.h, a, rgb: null };
        if (L.color) {
            out.rgb = new Uint8Array(w * h * 3);
            for (let i = 0; i < a.length; i++) {
                out.rgb[i * 3] = d[i * 4]; out.rgb[i * 3 + 1] = d[i * 4 + 1]; out.rgb[i * 3 + 2] = d[i * 4 + 2];
            }
        }
        return (L.mip = out);
    }

    /** depth map มองจากทิศที่ฉาย (เฉพาะผิวที่ต่อจากจุดวาง) — กันลายทะลุไปโผล่ผิวที่ถูกบังอยู่ */
    function depthMap(F, half, reach) {
        const ZN = 160, cell = (2 * half) / ZN;
        const Z = new Float32Array(ZN * ZN).fill(-Infinity);
        const { T, U, n, p } = F;
        const B = body(S.gender);
        for (const name of PAINTABLE) {
            const m = B[name];
            if (!m) continue;
            const ok = reach[name];
            const P = m.pos, I = m.idx, nv = P.length / 3;
            const gx = new Float32Array(nv), gy = new Float32Array(nv), gz = new Float32Array(nv);
            for (let v = 0; v < nv; v++) {
                const dx = P[v * 3] - p[0], dy = P[v * 3 + 1] - p[1], dz = P[v * 3 + 2] - p[2];
                gx[v] = (dx * T[0] + dy * T[1] + dz * T[2] + half) / cell;
                gy[v] = (dx * U[0] + dy * U[1] + dz * U[2] + half) / cell;
                gz[v] = dx * n[0] + dy * n[1] + dz * n[2];
            }
            for (let t = 0; t < I.length; t += 3) {
                if (!ok[t / 3]) continue;
                const a = I[t], b = I[t + 1], c = I[t + 2];
                const minX = Math.max(0, Math.floor(Math.min(gx[a], gx[b], gx[c])));
                const maxX = Math.min(ZN - 1, Math.ceil(Math.max(gx[a], gx[b], gx[c])));
                const minY = Math.max(0, Math.floor(Math.min(gy[a], gy[b], gy[c])));
                const maxY = Math.min(ZN - 1, Math.ceil(Math.max(gy[a], gy[b], gy[c])));
                if (minX > maxX || minY > maxY) continue;
                const area = (gx[b] - gx[a]) * (gy[c] - gy[a]) - (gx[c] - gx[a]) * (gy[b] - gy[a]);
                if (Math.abs(area) < 1e-9) continue;
                for (let y = minY; y <= maxY; y++) {
                    const py = y + 0.5;
                    for (let x = minX; x <= maxX; x++) {
                        const px = x + 0.5;
                        const w0 = ((gx[b] - px) * (gy[c] - py) - (gx[c] - px) * (gy[b] - py)) / area;
                        const w1 = ((gx[c] - px) * (gy[a] - py) - (gx[a] - px) * (gy[c] - py)) / area;
                        const w2 = 1 - w0 - w1;
                        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                        const z = w0 * gz[a] + w1 * gz[b] + w2 * gz[c];
                        if (z > Z[y * ZN + x]) Z[y * ZN + x] = z;
                    }
                }
            }
        }
        return { Z, ZN, cell };
    }

    /** น้ำหนัก barycentric ของพิกเซล i (ภาพขนาด size) ในสามเหลี่ยม t → out[0..2] */
    function baryOf(m, t, i, size, out) {
        const I = m.idx, UV = m.uv;
        const a = I[t * 3] * 2, b = I[t * 3 + 1] * 2, c = I[t * 3 + 2] * 2;
        const x0 = UV[a] * size, y0 = UV[a + 1] * size, x1 = UV[b] * size, y1 = UV[b + 1] * size;
        const x2 = UV[c] * size, y2 = UV[c + 1] * size;
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (Math.abs(area) < 1e-12) return false;
        const py = ((i / size) | 0) + 0.5;
        let best = -Infinity;
        for (const shift of Math.max(x0, x1, x2) > size ? [0, size] : [0]) {   // u เกิน 1 (มือตัวผู้หญิง)
            const px = (i % size) + 0.5 + shift;
            const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
            const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
            const w2 = 1 - w0 - w1;
            const low = Math.min(w0, w1, w2);
            if (low > best) { best = low; out[0] = w0; out[1] = w1; out[2] = w2; }
        }
        return true;
    }

    /** อบลายลงภาพ UV ของชิ้นหนึ่ง: ทุกพิกเซลผิว → จุดบนตัว → ตำแหน่งบนรูปลาย
     *  line = null ไม่ต้องทำกรอบ (ตอนส่งออก) · stick = แผนที่ตามผิว (วิธีวางติดตามผิว) */
    function project(L, F, M, reach, depth, ink, line, stick) {
        const src = layerPixels(L, M.size);
        const s = F.s, hw = L.w / 2, hh = L.h / 2;
        const ssx = s * L.sx, ssy = s * L.sy;                  // เมตรต่อพิกเซลรูป แนวกว้าง / สูง
        const half = Math.hypot(hw * L.sx, hh * L.sy) * s;
        const rot = -L.rot * Math.PI / 180, cr = Math.cos(rot), sr = Math.sin(rot);
        const fx = L.flipX ? -1 : 1, fy = L.flipY ? -1 : 1;
        const tex = M.size / SIZE;
        const ex = 1.3 / Math.max(L.scale * L.sx * tex, 1e-3), ey = 1.3 / Math.max(L.scale * L.sy * tex, 1e-3);
        const P = M.pos, Nn = M.nrm, C = M.cov;
        const W = F.wrap;
        const o = W ? W.c : F.p, n = W ? W.N : F.n, T = W ? W.R : F.T, U = W ? W.A : F.U;
        const sw = src.w, sh = src.h, sa = src.a, rgb = src.rgb;
        const bc = [0, 0, 0];
        let any = false;

        for (let i = 0; i < C.length; i++) {
            if (!C[i] || !reach[M.tri[i]]) continue;
            const q = i * 3;
            let xr, yr, facing;
            if (stick) {
                // ติดตามผิว: ตำแหน่งบนรูป = ค่าเฉลี่ยของจุดมุมสามเหลี่ยมบนแผนที่ตามผิว
                const t = M.tri[i];
                if (!baryOf(stick.m, t, i, M.size, bc)) continue;
                const I = stick.m.idx, map = stick.map, D = stick.dem;
                const na = map[I[t * 3]], nb = map[I[t * 3 + 1]], nc = map[I[t * 3 + 2]];
                xr = bc[0] * D.coord[na * 2] + bc[1] * D.coord[nb * 2] + bc[2] * D.coord[nc * 2];
                yr = -(bc[0] * D.coord[na * 2 + 1] + bc[1] * D.coord[nb * 2 + 1] + bc[2] * D.coord[nc * 2 + 1]);
                facing = 1;
            } else {
                const dx = P[q] - o[0], dy = P[q + 1] - o[1], dz = P[q + 2] - o[2];
                const a = dx * T[0] + dy * T[1] + dz * T[2];
                const b = dx * U[0] + dy * U[1] + dz * U[2];
                const z = dx * n[0] + dy * n[1] + dz * n[2];
                if (W) {
                    if (b > half || b < -half) continue;
                    const dist = Math.hypot(a, z);
                    if (dist < W.r * 0.5 || dist > W.r * 1.5) continue;             // อยู่บนแขน/ขาเดียวกัน
                    facing = (Nn[q] * (a * T[0] + z * n[0]) + Nn[q + 1] * (a * T[1] + z * n[1]) + Nn[q + 2] * (a * T[2] + z * n[2])) / dist;
                    if (facing < 0.25) continue;                                    // ผิวที่หันออกจากแกนเท่านั้น
                    xr = Math.atan2(a, z) * W.r;                                    // ระยะตามผิวรอบแกน
                } else {
                    if (a > half || a < -half || b > half || b < -half) continue;
                    facing = Nn[q] * n[0] + Nn[q + 1] * n[1] + Nn[q + 2] * n[2];
                    if (facing < 0.05) continue;
                    const zx = Math.min(depth.ZN - 1, ((a + half) / depth.cell) | 0);
                    const zy = Math.min(depth.ZN - 1, ((b + half) / depth.cell) | 0);
                    const slack = 0.004 + depth.cell * (1.5 + Math.sqrt(1 - facing * facing) / Math.max(facing, 0.05));
                    if (z < depth.Z[zy * depth.ZN + zx] - slack) continue;
                    xr = a;
                }
                yr = -b;
            }
            const lx = ((xr * cr - yr * sr) / ssx) * fx + hw;
            const ly = ((xr * sr + yr * cr) / ssy) * fy + hh;
            if (lx < 0 || ly < 0 || lx >= L.w || ly >= L.h) continue;

            // อ่านค่าหมึกแบบเกลี่ย 4 จุด
            const sx = lx * src.kx - 0.5, sy = ly * src.ky - 0.5;
            const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
            const x1 = x0 + 1, y1 = y0 + 1;
            const i00 = x0 >= 0 && y0 >= 0 && x0 < sw && y0 < sh ? y0 * sw + x0 : -1;
            const i10 = x1 >= 0 && y0 >= 0 && x1 < sw && y0 < sh ? y0 * sw + x1 : -1;
            const i01 = x0 >= 0 && y1 >= 0 && x0 < sw && y1 < sh ? y1 * sw + x0 : -1;
            const i11 = x1 >= 0 && y1 >= 0 && x1 < sw && y1 < sh ? y1 * sw + x1 : -1;
            const w00 = i00 < 0 ? 0 : (1 - tx) * (1 - ty) * sa[i00];
            const w10 = i10 < 0 ? 0 : tx * (1 - ty) * sa[i10];
            const w01 = i01 < 0 ? 0 : (1 - tx) * ty * sa[i01];
            const w11 = i11 < 0 ? 0 : tx * ty * sa[i11];
            const sum = w00 + w10 + w01 + w11;
            const v = sum * Math.min(1, facing * 4);
            const k = i * 4;
            if (v > ink[k + 3]) {
                ink[k + 3] = v;
                any = true;
                if (rgb && sum > 0) {
                    for (let ch = 0; ch < 3; ch++) {
                        ink[k + ch] = ((i00 < 0 ? 0 : w00 * rgb[i00 * 3 + ch]) + (i10 < 0 ? 0 : w10 * rgb[i10 * 3 + ch])
                            + (i01 < 0 ? 0 : w01 * rgb[i01 * 3 + ch]) + (i11 < 0 ? 0 : w11 * rgb[i11 * 3 + ch])) / sum;
                    }
                }
            }
            if (line && (Math.min(lx, L.w - lx) < ex || Math.min(ly, L.h - ly) < ey)) {
                line[k] = PICKED[0]; line[k + 1] = PICKED[1]; line[k + 2] = PICKED[2]; line[k + 3] = 255;
            }
        }
        return any;
    }

    // ───────────────────────────────────────── ระยะตามผิว ───────────

    const graphs = {};

    /** จุดของท่อนบน + ขารวมเป็นกราฟเดียว (จุดตำแหน่งเดียวกันตรงรอยต่อชิ้น/เอวนับเป็นจุดเดียว) */
    function graph(g) {
        if (graphs[g]) return graphs[g];
        const B = body(g);
        const ids = new Map(), xyz = [], nodeOf = {};
        for (const part of PAINTABLE) {
            const m = B[part];
            if (!m) continue;
            const map = new Int32Array(m.pos.length / 3);
            for (let v = 0; v < map.length; v++) {
                const k = Math.round(m.pos[v * 3] * 1000) + ',' + Math.round(m.pos[v * 3 + 1] * 1000) + ',' + Math.round(m.pos[v * 3 + 2] * 1000);
                let id = ids.get(k);
                if (id === undefined) {
                    id = xyz.length / 3;
                    ids.set(k, id);
                    xyz.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]);
                }
                map[v] = id;
            }
            nodeOf[part] = map;
        }
        const n = xyz.length / 3;
        // ทิศผิวของแต่ละจุด (เฉลี่ยจุดที่ซ้อนกันตรงรอยต่อ)
        const nn = new Float32Array(n * 3);
        for (const part of PAINTABLE) {
            const m = B[part];
            if (!m) continue;
            const map = nodeOf[part];
            for (let v = 0; v < map.length; v++) for (let k = 0; k < 3; k++) nn[map[v] * 3 + k] += m.nrm[v * 3 + k];
        }
        for (let i = 0; i < n; i++) {
            const l = Math.hypot(nn[i * 3], nn[i * 3 + 1], nn[i * 3 + 2]) || 1;
            nn[i * 3] /= l; nn[i * 3 + 1] /= l; nn[i * 3 + 2] /= l;
        }
        const lists = Array.from({ length: n }, () => []);
        for (const part of PAINTABLE) {
            const m = B[part];
            if (!m) continue;
            const map = nodeOf[part], I = m.idx;
            for (let t = 0; t < I.length; t += 3) {
                for (let e = 0; e < 3; e++) {
                    const na = map[I[t + e]], nb = map[I[t + (e + 1) % 3]];
                    if (na !== nb) { lists[na].push(nb); lists[nb].push(na); }
                }
            }
        }
        const start = new Int32Array(n + 1);
        for (let i = 0; i < n; i++) start[i + 1] = start[i] + lists[i].length;
        const nbr = new Int32Array(start[n]), len = new Float32Array(start[n]);
        for (let i = 0; i < n; i++) {
            lists[i].forEach((j, k) => {
                nbr[start[i] + k] = j;
                len[start[i] + k] = Math.hypot(xyz[i * 3] - xyz[j * 3], xyz[i * 3 + 1] - xyz[j * 3 + 1], xyz[i * 3 + 2] - xyz[j * 3 + 2]);
            });
        }
        return (graphs[g] = { n, xyz, nn, nodeOf, start, nbr, len });
    }

    /** สามเหลี่ยมของแต่ละชิ้นที่อยู่ในระยะ R ตามผิวจากจุดวาง { upper: Uint8Array, lower: Uint8Array } */
    function reachable(F, R) {
        const g = S.gender, G = graph(g), B = body(g);
        const dist = new Float64Array(G.n).fill(Infinity);     // 64 บิตเท่ากับระยะใน heap (32 บิตปัดแล้วทำให้ข้ามจุด)
        const hn = [], hd = [];                                  // heap: จุด / ระยะ
        const push = (node, d) => {
            let i = hn.length;
            hn.push(node);
            hd.push(d);
            while (i > 0) {
                const up = (i - 1) >> 1;
                if (hd[up] <= d) break;
                hn[i] = hn[up]; hd[i] = hd[up];
                i = up;
            }
            hn[i] = node; hd[i] = d;
        };
        const pop = () => {
            const top = hn[0], topD = hd[0];
            const ln = hn.pop(), ld = hd.pop();
            if (hn.length) {
                let i = 0;
                for (;;) {
                    const l = i * 2 + 1, r = l + 1;
                    let m = i, md = ld;
                    if (l < hn.length && hd[l] < md) { m = l; md = hd[l]; }
                    if (r < hn.length && hd[r] < md) { m = r; md = hd[r]; }
                    if (m === i) break;
                    hn[i] = hn[m]; hd[i] = hd[m];
                    i = m;
                }
                hn[i] = ln; hd[i] = ld;
            }
            return [top, topD];
        };

        const I0 = B[F.part].idx, map0 = G.nodeOf[F.part];
        for (let k = 0; k < 3; k++) {
            const node = map0[I0[F.tri * 3 + k]];
            const d = Math.hypot(G.xyz[node * 3] - F.p[0], G.xyz[node * 3 + 1] - F.p[1], G.xyz[node * 3 + 2] - F.p[2]);
            if (d < dist[node]) { dist[node] = d; push(node, d); }
        }
        while (hn.length) {
            const [node, d] = pop();
            if (d > dist[node]) continue;
            if (d > R) break;
            for (let k = G.start[node]; k < G.start[node + 1]; k++) {
                const j = G.nbr[k], nd = d + G.len[k];
                if (nd < dist[j]) { dist[j] = nd; push(j, nd); }
            }
        }

        // ฉายตรง: ใช้เฉพาะผิวที่ระยะตามผิวไม่ไกลกว่าระยะบนแผ่นฉายมากนัก
        // (แขนที่ห้อยข้างลำตัวอยู่ใกล้บนแผ่นฉาย แต่ต้องอ้อมรักแร้ไปถึง — ไม่รับหมึกและไม่บังลำตัว)
        const near = new Uint8Array(G.n);
        for (let v = 0; v < G.n; v++) {
            if (!(dist[v] <= R)) continue;
            if (F.wrap) { near[v] = 1; continue; }
            const dx = G.xyz[v * 3] - F.p[0], dy = G.xyz[v * 3 + 1] - F.p[1], dz = G.xyz[v * 3 + 2] - F.p[2];
            const planar = Math.hypot(dx * F.T[0] + dy * F.T[1] + dz * F.T[2], dx * F.U[0] + dy * F.U[1] + dz * F.U[2]);
            near[v] = dist[v] <= planar * 1.6 + 0.03 ? 1 : 0;
        }

        const out = {};
        for (const part of PAINTABLE) {
            const m = B[part];
            if (!m) { out[part] = new Uint8Array(0); continue; }
            const map = G.nodeOf[part], I = m.idx, ok = new Uint8Array(I.length / 3);
            for (let t = 0; t < I.length; t += 3) {
                ok[t / 3] = near[map[I[t]]] | near[map[I[t + 1]]] | near[map[I[t + 2]]];
            }
            out[part] = ok;
        }
        return out;
    }

    /** แผนที่ตามผิว (discrete exponential map): ทุกจุดรอบจุดวางได้พิกัด 2D (เมตร) ตามระยะบนผิว
     *  เหมือนวางกระดาษลอกลายแนบผิว — ลายไม่ยืดตรงที่โค้ง ต่อข้ามรอยต่อ / ข้ามเอวได้
     *  ไล่จากจุดใกล้ไปไกล: จุดใหม่ = พิกัดของจุดข้างเคียงที่ทำแล้ว + ก้าวบนระนาบผิวของจุดนั้น (เฉลี่ยหลายทาง) */
    function expMap(F, R) {
        const G = graph(S.gender), B = body(S.gender);
        const n = G.n, X = G.xyz, NN = G.nn;
        const dist = new Float64Array(n).fill(Infinity);
        const coord = new Float64Array(n * 2), frame = new Float64Array(n * 6);
        const done = new Uint8Array(n), seed = new Uint8Array(n);
        const hn = [], hd = [];
        const push = (node, d) => {
            let i = hn.length;
            hn.push(node); hd.push(d);
            while (i > 0) {
                const up = (i - 1) >> 1;
                if (hd[up] <= d) break;
                hn[i] = hn[up]; hd[i] = hd[up];
                i = up;
            }
            hn[i] = node; hd[i] = d;
        };
        const pop = () => {
            const top = hn[0], topD = hd[0];
            const ln = hn.pop(), ld = hd.pop();
            if (hn.length) {
                let i = 0;
                for (;;) {
                    const l = i * 2 + 1, r = l + 1;
                    let m = i, md = ld;
                    if (l < hn.length && hd[l] < md) { m = l; md = hd[l]; }
                    if (r < hn.length && hd[r] < md) { m = r; md = hd[r]; }
                    if (m === i) break;
                    hn[i] = hn[m]; hd[i] = hd[m];
                    i = m;
                }
                hn[i] = ln; hd[i] = ld;
            }
            return [top, topD];
        };
        // แกน T/U ของจุด v = แกนของจุดก่อนหน้า บิดให้แนบระนาบผิวของ v
        const carry = (v, Tx, Ty, Tz) => {
            const nx = NN[v * 3], ny = NN[v * 3 + 1], nz = NN[v * 3 + 2];
            const k = Tx * nx + Ty * ny + Tz * nz;
            let tx = Tx - nx * k, ty = Ty - ny * k, tz = Tz - nz * k;
            const l = Math.hypot(tx, ty, tz) || 1;
            tx /= l; ty /= l; tz /= l;
            frame[v * 6] = tx; frame[v * 6 + 1] = ty; frame[v * 6 + 2] = tz;
            frame[v * 6 + 3] = ny * tz - nz * ty;               // U = n × T
            frame[v * 6 + 4] = nz * tx - nx * tz;
            frame[v * 6 + 5] = nx * ty - ny * tx;
        };

        const I0 = B[F.part].idx, map0 = G.nodeOf[F.part];
        for (let k = 0; k < 3; k++) {
            const v = map0[I0[F.tri * 3 + k]];
            const d = [X[v * 3] - F.p[0], X[v * 3 + 1] - F.p[1], X[v * 3 + 2] - F.p[2]];
            coord[v * 2] = dot(d, F.T);
            coord[v * 2 + 1] = dot(d, F.U);
            carry(v, F.T[0], F.T[1], F.T[2]);
            seed[v] = 1;
            dist[v] = Math.hypot(d[0], d[1], d[2]);
            push(v, dist[v]);
        }

        while (hn.length) {
            const [u, d] = pop();
            if (done[u] || d > dist[u]) continue;
            if (d > R) break;
            if (!seed[u]) {
                let sx = 0, sy = 0, sw = 0, parent = -1, pd = Infinity;
                for (let k = G.start[u]; k < G.start[u + 1]; k++) {
                    const w = G.nbr[k];
                    if (!done[w]) continue;
                    const ex = X[u * 3] - X[w * 3], ey = X[u * 3 + 1] - X[w * 3 + 1], ez = X[u * 3 + 2] - X[w * 3 + 2];
                    const len = Math.hypot(ex, ey, ez);
                    const nx = NN[w * 3], ny = NN[w * 3 + 1], nz = NN[w * 3 + 2];
                    const kn = ex * nx + ey * ny + ez * nz;
                    const tx = ex - nx * kn, ty = ey - ny * kn, tz = ez - nz * kn;
                    const tl = Math.hypot(tx, ty, tz);
                    if (tl < 1e-9) continue;
                    const f = len / tl;                              // คงความยาวก้าวตามผิว
                    const o = w * 6;
                    const cx = coord[w * 2] + (tx * frame[o] + ty * frame[o + 1] + tz * frame[o + 2]) * f;
                    const cy = coord[w * 2 + 1] + (tx * frame[o + 3] + ty * frame[o + 4] + tz * frame[o + 5]) * f;
                    const wt = 1 / (len + 1e-4);
                    sx += cx * wt; sy += cy * wt; sw += wt;
                    if (dist[w] + len < pd) { pd = dist[w] + len; parent = w; }
                }
                if (!sw) continue;
                coord[u * 2] = sx / sw;
                coord[u * 2 + 1] = sy / sw;
                carry(u, frame[parent * 6], frame[parent * 6 + 1], frame[parent * 6 + 2]);
            }
            done[u] = 1;
            for (let k = G.start[u]; k < G.start[u + 1]; k++) {
                const j = G.nbr[k], nd = d + G.len[k];
                if (nd < dist[j]) { dist[j] = nd; push(j, nd); }
            }
        }
        return { coord, done };
    }

    /** ก่อนอบ: ผิวที่ลงหมึกได้ + depth map (แบบฉาย) หรือแผนที่ตามผิว (ติดตามผิว) */
    function prepare(L, F) {
        const half = Math.hypot(L.w / 2 * L.sx, L.h / 2 * L.sy) * F.s;
        if (L.place === 'stick') {
            const dem = expMap(F, half * 1.3 + 0.02);
            const G = graph(S.gender), B = body(S.gender);
            const reach = {}, stick = {};
            for (const part of PAINTABLE) {
                const m = B[part];
                if (!m) { reach[part] = new Uint8Array(0); continue; }
                const map = G.nodeOf[part], I = m.idx, ok = new Uint8Array(I.length / 3);
                for (let t = 0; t < I.length; t += 3) ok[t / 3] = dem.done[map[I[t]]] & dem.done[map[I[t + 1]]] & dem.done[map[I[t + 2]]];
                reach[part] = ok;
                stick[part] = { dem, m, map };
            }
            return { reach, depth: null, stick, dem };
        }
        // ลงหมึกเฉพาะผิวที่ต่อจากจุดวางภายในระยะตามผิวของขนาดลาย
        // (ไม่งั้นแขนที่ห้อยบังข้างลำตัวจะรับหมึกไปด้วย)
        const reach = reachable(F, half * 1.5 + 0.02);
        return { reach, depth: F.wrap ? null : depthMap(F, half, reach), stick: {}, dem: null };
    }

    /** เกาะ UV ของแต่ละสามเหลี่ยม (สามเหลี่ยมที่แตะจุด UV เดียวกันอยู่เกาะเดียวกัน) — ใช้แยกชิ้นลายตามรอยต่อ */
    function islands(m) {
        const I = m.idx, nt = I.length / 3, uv = m.uv;
        const at = new Map();
        const key = new Int32Array(uv.length / 2);
        for (let v = 0; v < key.length; v++) {
            const k = Math.round(uv[v * 2] * 65536) + ',' + Math.round(uv[v * 2 + 1] * 65536);
            let id = at.get(k);
            if (id === undefined) at.set(k, id = at.size);
            key[v] = id;
        }
        const parent = new Int32Array(at.size).map((_, i) => i);
        const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        for (let t = 0; t < I.length; t += 3) {
            const a = find(key[I[t]]);
            parent[find(key[I[t + 1]])] = a;
            parent[find(key[I[t + 2]])] = a;
        }
        const out = new Int32Array(nt);
        for (let t = 0; t < nt; t++) out[t] = find(key[I[t * 3]]);
        return out;
    }

    const islandCache = {};

    /** เกาะ UV ของทุกพิกเซลบนภาพ 512 ของชิ้นนั้น (-1 = ไม่ใช่ผิว) */
    function texelIslands(part) {
        const id = S.gender + ':' + part;
        if (islandCache[id]) return islandCache[id];
        const out = new Int32Array(SIZE * SIZE).fill(-1);
        if (body(S.gender)[part]) {
            const M = surface(S.gender, part);
            for (let i = 0; i < out.length; i++) if (M.cov[i]) out[i] = M.island[M.tri[i]];
        }
        return (islandCache[id] = out);
    }

    function canvas512() {
        const c = document.createElement('canvas');
        c.width = c.height = SIZE;
        return c;
    }

    /** ลายติดบนตัวที่อบแล้ว { frame, parts: { upper|lower: { ink, line, alpha, any } } } — อบใหม่เมื่อมีอะไรเปลี่ยน */
    function bake(L) {
        const g = S.gender;
        const key = [g, L.place, partOf(L), L.x, L.y, L.scale, L.sx, L.sy, L.rot, L.flipX, L.flipY, L.color, L.maskVer || 0,
            L.place === 'view' && L.view ? L.view.n.concat(L.view.up).join(',') : ''].join('|');
        L.bakes = L.bakes || {};
        let B = L.bakes[g];
        if (B && B.key === key && B.mask === L.mask) return B;
        if (!B || B.mask !== L.mask) {
            B = L.bakes[g] = { mask: L.mask, parts: {} };
            for (const part of PAINTABLE) B.parts[part] = { ink: canvas512(), line: canvas512() };
        }
        B.key = key;
        B.frame = layerFrame(L);
        const F = B.frame;
        const prep = F ? prepare(L, F) : null;
        B.dem = prep && prep.dem;
        for (const part of PAINTABLE) {
            const out = B.parts[part];
            const ink = new ImageData(SIZE, SIZE), line = new ImageData(SIZE, SIZE);
            out.any = false;
            if (F && body(g)[part]) {
                out.any = project(L, F, surface(g, part), prep.reach[part], prep.depth, ink.data, line.data, prep.stick[part]);
            }
            out.alpha = ink.data;
            out.ink.getContext('2d').putImageData(ink, 0, 0);
            out.line.getContext('2d').putImageData(line, 0, 0);
        }
        return B;
    }

    /** ลายติดบนตัวอบที่ความละเอียด res (ตอนส่งออก 1024 / 2048) → canvas */
    function bakeAt(L, part, res, g = S.gender) {
        return inGender(L, g, () => bakeAtNow(L, part, res));
    }

    function bakeAtNow(L, part, res) {
        if (res === SIZE) return bake(L).parts[part].ink;
        const c = document.createElement('canvas');
        c.width = c.height = res;
        const B = bake(L), F = B.frame;
        if (!F || !B.parts[part].any) return c;
        const prep = prepare(L, F);
        const ink = new ImageData(res, res);
        project(L, F, surface(S.gender, part, res), prep.reach[part], prep.depth, ink.data, null, prep.stick[part]);
        c.getContext('2d').putImageData(ink, 0, 0);
        return c;
    }

    /** คืนหน่วยความจำของแผนที่ผิวความละเอียดสูงหลังส่งออก (2048 ใช้ราว 100 MB) */
    function releaseHiRes() {
        for (const id of Object.keys(surfaces)) if (!id.endsWith(':' + SIZE)) delete surfaces[id];
    }

    /** พิกเซล (tx, ty) บนภาพของชิ้น part ตกตรงไหนของรูปลาย L (ใช้กับยางลบ) → { lx, ly } หรือ null */
    function imageAtTexel(L, part, tx, ty) {
        const B = bake(L), F = B.frame, m = body(S.gender)[part];
        if (!F || !m) return null;
        const M = surface(S.gender, part);
        const i = clamp(Math.floor(ty), 0, SIZE - 1) * SIZE + Math.floor(mod(tx, SIZE));
        if (!M.cov[i]) return null;
        let xr, yr;
        if (B.dem) {
            const t = M.tri[i], bc = [0, 0, 0], I = m.idx, map = graph(S.gender).nodeOf[part], D = B.dem;
            if (!baryOf(m, t, i, SIZE, bc)) return null;
            const na = map[I[t * 3]], nb = map[I[t * 3 + 1]], nc = map[I[t * 3 + 2]];
            if (!D.done[na] || !D.done[nb] || !D.done[nc]) return null;
            xr = bc[0] * D.coord[na * 2] + bc[1] * D.coord[nb * 2] + bc[2] * D.coord[nc * 2];
            yr = -(bc[0] * D.coord[na * 2 + 1] + bc[1] * D.coord[nb * 2 + 1] + bc[2] * D.coord[nc * 2 + 1]);
        } else {
            const W = F.wrap;
            const o = W ? W.c : F.p, n = W ? W.N : F.n, T = W ? W.R : F.T, U = W ? W.A : F.U;
            const d = [M.pos[i * 3] - o[0], M.pos[i * 3 + 1] - o[1], M.pos[i * 3 + 2] - o[2]];
            const a = dot(d, T), b = dot(d, U);
            xr = W ? Math.atan2(a, dot(d, n)) * W.r : a;
            yr = -b;
        }
        const r = -L.rot * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
        let lx = (xr * c - yr * sn) / (F.s * L.sx), ly = (xr * sn + yr * c) / (F.s * L.sy);
        if (L.flipX) lx = -lx;
        if (L.flipY) ly = -ly;
        return { lx: lx + L.w / 2, ly: ly + L.h / 2 };
    }

    /** ภาพตัว 3D ตอนนี้ (พื้นใส ไม่มีกรอบ/ไกด์) — ใช้ทำรูปในร้าน */
    function snapshot() {
        if (!gl || !prog || !shown()) return null;
        const keepOutline = outline, keepGuide = S.uvGuide;
        outline = false;
        S.uvGuide = false;
        texDirty.male = texDirty.female = true;
        cancelAnimationFrame(raf);
        draw();
        const c = document.createElement('canvas');
        c.width = canvas.width;
        c.height = canvas.height;
        c.getContext('2d').drawImage(canvas, 0, 0);
        outline = keepOutline;
        S.uvGuide = keepGuide;
        schedule(true);
        return c;
    }

    /** ทิศกล้องตอนนี้ (สำหรับวิธีวาง "ฉายจากมุมกล้อง") */
    function cameraFrame() {
        const { y, z } = basis();
        return { n: z.slice(), up: y.slice() };
    }

    /** มีหมึกของลายติดบนตัวตรงพิกเซลนี้ (บนภาพของชิ้น part) ไหม */
    function bakedHit(L, tx, ty, part = S.uvPart, reach = 2) {
        const a = bake(L).parts[part].alpha;
        const cx = Math.floor(mod(tx, SIZE)), cy = Math.floor(ty);
        for (let dy = -reach; dy <= reach; dy++) {
            for (let dx = -reach; dx <= reach; dx++) {
                const x = mod(cx + dx, SIZE), y = cy + dy;
                if (y >= 0 && y < SIZE && a[(y * SIZE + x) * 4 + 3] > 24) return true;
            }
        }
        return false;
    }

    /** ยิงจากนอกตัวเข้าหาผิว → ตำแหน่งบนภาพของชิ้นที่ลงลายได้ { x, y, part } */
    function anchorFrom(o, d, g = S.gender) {
        const h = castBody(o, d, g);
        return h && h.paint ? { x: h.px, y: h.py, part: h.part } : null;
    }

    // ───────────────────────────────────────── ท่าของชาย / หญิง ─────
    // ตำแหน่ง ขนาด หมุน ของแต่ละเพศเก็บแยกใน L.poses[g] (ภาพ UV ของชายกับหญิงไม่เหมือนกัน)
    // ค่าบนตัว L คือของเพศที่กำลังแก้ (S.gender) — สลับเพศแล้วสลับค่าตามกัน ไม่คำนวณใหม่จนเพี้ยน

    const POSE_KEYS = ['x', 'y', 'part', 'scale', 'sx', 'sy', 'rot', 'view'];

    function poseOf(L) {
        const o = {};
        for (const k of POSE_KEYS) o[k] = L[k];
        if (o.view) o.view = { n: o.view.n.slice(), up: o.view.up.slice() };
        return o;
    }

    /** จุดกลางของเลเยอร์บนตัว (เพศที่กำลังแก้) → { p, n } */
    function layerPoint(L) {
        if (L.place !== 'uv') {
            const F = bake(L).frame;
            return F ? { p: F.p, n: F.n } : null;
        }
        const M = surface(S.gender, partOf(L));
        const i = clamp(Math.floor(L.y), 0, SIZE - 1) * SIZE + Math.floor(mod(L.x, SIZE));
        if (!M.cov[i]) return null;
        return { p: [M.pos[i * 3], M.pos[i * 3 + 1], M.pos[i * 3 + 2]], n: [M.nrm[i * 3], M.nrm[i * 3 + 1], M.nrm[i * 3 + 2]] };
    }

    /** ท่าของเพศ g ยังไม่มี → ตั้งต้นจากเพศที่กำลังแก้ ที่จุดเดียวกันบนตัว (หลังจากนั้นแยกกัน) */
    function ensurePose(L, g) {
        L.poses = L.poses || {};
        if (g === S.gender || L.poses[g]) return;
        const pose = poseOf(L);
        const at = layerPoint(L);
        const on = at && anchorFrom(add(at.p, at.n, 0.06), neg(at.n), g);
        if (on) Object.assign(pose, on);
        L.poses[g] = pose;
    }

    /** ทำงานกับเลเยอร์ในท่า + โมเดลของเพศ g ชั่วคราว */
    function inGender(L, g, fn) {
        if (g === S.gender) return fn();
        ensurePose(L, g);
        const saved = poseOf(L), was = S.gender;
        Object.assign(L, L.poses[g]);
        S.gender = g;
        try { return fn(); } finally { S.gender = was; Object.assign(L, saved); }
    }

    function bakeFor(L, g) {
        return inGender(L, g, () => bake(L));
    }

    /** ใช้ตำแหน่งจากอีกเพศ มาวางที่จุดเดียวกันบนตัวเพศนี้ */
    function copyPoseFromOther(L) {
        const other = S.gender === 'male' ? 'female' : 'male';
        if (!L.poses || !L.poses[other]) return false;
        const src = inGender(L, other, () => Object.assign(poseOf(L), { at: layerPoint(L) }));
        const on = src.at && anchorFrom(add(src.at.p, src.at.n, 0.06), neg(src.at.n));
        Object.assign(L, { scale: src.scale, sx: src.sx, sy: src.sy, rot: src.rot, view: src.view }, on || {});
        return true;
    }

    /** จุดเริ่มของลายใหม่: กลางอก */
    function defaultAnchor() {
        const m = body(S.gender).upper;
        return anchorFrom([0, m.min[1] + (m.max[1] - m.min[1]) * 0.66, 2], [0, 0, -1])
            || { x: SIZE / 2, y: SIZE / 2, part: 'upper' };
    }

    /** ขนาดเริ่มต้น ~14 ซม. ด้านยาว */
    function defaultScale(L) {
        return clamp(0.14 / (surface(S.gender, partOf(L)).mpp * Math.max(L.w, L.h)), 0.02, 8);
    }

    /** จุดเดียวกันบนตัวอีกฝั่ง (สะท้อนซ้าย-ขวา) */
    function mirrorAnchor(L) {
        const F = bake(L).frame;
        if (!F) return null;
        const p = [-F.p[0], F.p[1], F.p[2]], n = [-F.n[0], F.n[1], F.n[2]];
        return anchorFrom(add(p, n, 0.03), neg(n));
    }

    // ───────────────────────────────────────── WebGL ───────────────

    const canvas = $('body3d');
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true });

    const VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec2 aUv;
uniform mat4 uMvp;
uniform vec3 uOffset;
varying vec3 vP;
varying vec3 vN;
varying vec2 vUv;
void main() {
    vP = aPos + uOffset;
    vN = aNrm;
    vUv = aUv;
    gl_Position = uMvp * vec4(vP, 1.0);
}`;

    const FS = `
precision mediump float;
uniform sampler2D uTex;
uniform vec3 uEye;
uniform vec3 uTint;
uniform float uAlpha;
varying vec3 vP;
varying vec3 vN;
varying vec2 vUv;
void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(uEye - vP);
    if (dot(n, v) < 0.0) n = -n;
    vec3 base = texture2D(uTex, vUv).rgb * uTint;
    float key = max(dot(n, normalize(v + vec3(0.0, 0.55, 0.0))), 0.0);
    float top = max(n.y, 0.0);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    gl_FragColor = vec4(base * (0.34 + 0.6 * key + 0.14 * top) + rim * 0.1, uAlpha);
}`;

    let prog = null, loc = null;
    let tint = [1, 1, 1];
    let uintExt = null;          // index 32 บิต (เสื้อผ้าบางชิ้นจุดเกิน 65535)

    function compile(type, src) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
    }

    function setupGl() {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        loc = {};
        for (const a of ['aPos', 'aNrm', 'aUv']) loc[a] = gl.getAttribLocation(prog, a);
        for (const u of ['uMvp', 'uEye', 'uTex', 'uTint', 'uOffset', 'uAlpha']) loc[u] = gl.getUniformLocation(prog, u);
        uintExt = gl.getExtension('OES_element_index_uint');
    }

    function texParams(mip) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    function upload(tex, source) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.generateMipmap(gl.TEXTURE_2D);
        texParams(true);
    }

    /** ผิวของหัว (ท่อนบน/ขาวาดผ่าน paintPart เพราะมีลายทับ) */
    function setPartTexture(m, img) {
        if (img) return upload(m.gl.tex, img);
        gl.bindTexture(gl.TEXTURE_2D, m.gl.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([185, 141, 108, 255]));
        texParams(false);
    }

    function glPart(g, m) {
        if (m.gl) return m.gl;
        const buffer = (target, data) => {
            const b = gl.createBuffer();
            gl.bindBuffer(target, b);
            gl.bufferData(target, data, gl.STATIC_DRAW);
            return b;
        };
        m.gl = {
            pos: buffer(gl.ARRAY_BUFFER, m.pos),
            nrm: buffer(gl.ARRAY_BUFFER, m.nrm),
            uv: buffer(gl.ARRAY_BUFFER, m.uv),
            idx: buffer(gl.ELEMENT_ARRAY_BUFFER, m.idx),
            tex: gl.createTexture(),
        };
        setPartTexture(m, PAINTABLE.includes(m.name) ? null : skinOf(g, m.name));
        return m.gl;
    }

    /** สีผิวเฉลี่ยในส่วนที่โมเดลใช้จริง — ใช้แทนผิวที่ไม่มีไฟล์ */
    function skinTone(m, img) {
        const n = 64;
        const c = document.createElement('canvas');
        c.width = c.height = n;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, n, n);
        const px = ctx.getImageData(0, 0, n, n).data;
        const mask = uvMask(m, n).getContext('2d').getImageData(0, 0, n, n).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < px.length; i += 4) {
            if (mask[i + 3] < 250 || px[i + 3] < 250) continue;
            r += px[i]; g += px[i + 1]; b += px[i + 2]; count++;
        }
        return count ? `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})` : FALLBACK_SKIN;
    }

    /** สีผิวเรียบจากผิวชิ้นอื่นที่มีไฟล์ (ท่อนล่างก่อน แล้วท่อนบน) */
    function flatTone(g) {
        const B = body(g);
        if (!B.tone) {
            for (const part of ['lower', 'upper']) {
                const img = B[part] && skinOf(g, part);
                if (img) { B.tone = skinTone(B[part], img); break; }
            }
        }
        return B.tone || FALLBACK_SKIN;
    }

    function skinChanged(g, part) {
        const B = meshes[g];
        B.tone = null;
        if (gl && prog && part === 'head' && B.head && B.head.gl) setPartTexture(B.head, skinOf(g, 'head'));
        if (g === S.gender) updateNote();
        if (shownGenders().includes(g)) schedule(true);
    }

    // ───────────────────────────────────────── ผิว + ลาย ───────────

    const paints = {};                           // gender → part → canvas
    const tinted = new Map();

    function tintRef(img) {
        let c = tinted.get(img);
        if (!c) {
            c = canvas512();
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, SIZE, SIZE);
            ctx.globalCompositeOperation = 'source-in';
            ctx.fillStyle = REF_TINT;
            ctx.fillRect(0, 0, SIZE, SIZE);
            tinted.set(img, c);
        }
        return c;
    }

    /** ผิวของชิ้น + ลายทุกเลเยอร์ที่ลงชิ้นนี้ + ไกด์ + กรอบลายที่เลือก (ของเพศ g) */
    function paintPart(part, g) {
        const hi = g === S.gender ? hiResOf(part) : null;    // พรีวิวที่ความละเอียดส่งออก
        const size = hi ? hi.width : SIZE;
        paints[g] = paints[g] || {};
        const cvs = paints[g][part] || (paints[g][part] = canvas512());
        if (cvs.width !== size) cvs.width = cvs.height = size;
        const p = cvs.getContext('2d');
        p.setTransform(size / SIZE, 0, 0, size / SIZE, 0, 0);    // วาดในหน่วยภาพ 512 เสมอ
        p.globalAlpha = 1;
        p.imageSmoothingQuality = 'high';
        const skin = skinOf(g, part);
        if (skin) {
            p.drawImage(skin, 0, 0, SIZE, SIZE);
        } else {
            p.fillStyle = flatTone(g);
            p.fillRect(0, 0, SIZE, SIZE);
        }

        // ลายเดิมในเกม (มีแค่ท่อนบน — สีฟ้า แยกจากลายของเรา)
        if (part === 'upper') {
            if (S.refAll) {
                p.globalAlpha = S.refOpacity * 0.6;
                for (const name in refs) p.drawImage(tintRef(refs[name]), 0, 0);
            }
            if (S.refPick && refs[S.refPick]) {
                p.globalAlpha = Math.min(1, S.refOpacity * 1.5);
                p.drawImage(tintRef(refs[S.refPick]), 0, 0);
            }
        }

        // ลายของเรา (ภาพเดียวกับที่ export)
        p.globalAlpha = 0.9;
        p.drawImage(hi || compose(part, g), 0, 0, SIZE, SIZE);
        p.globalAlpha = 1;
        const thin = thinOverlay(part, g);
        if (thin) p.drawImage(thin, 0, 0, SIZE, SIZE);

        if (S.uvGuide) {
            p.globalAlpha = 0.75;
            strokeEdges(p, guide(g, part), 1.4);
            p.globalAlpha = 1;
        }

        const L = selected();
        if (outline && L && L.visible) {
            if (L.place !== 'uv') {
                p.drawImage((g === S.gender ? bake(L) : bakeFor(L, g)).parts[part].line, 0, 0);
            } else {
                inGender(L, g, () => {
                    if (partOf(L) !== part) return;
                    p.lineWidth = 2;
                    p.setLineDash([7, 5]);
                    p.strokeStyle = 'rgba(255, 255, 255, 0.95)';
                    for (const [ox, oy] of offsets()) {
                        const pts = corners(L, ox, oy);
                        p.beginPath();
                        pts.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])));
                        p.closePath();
                        p.stroke();
                    }
                    p.setLineDash([]);
                });
            }
        }
    }

    // ───────────────────────────────────────── พรีวิวความละเอียดสูง ──
    // ลากอยู่ใช้ภาพ 512 (ลื่น) หยุดขยับ ~0.5 วินาทีค่อยอบใหม่ที่ความละเอียดส่งออก

    let hiRes = null, hiTimer = 0;

    // ความละเอียดที่ส่งออกจริง (ลายสีล็อก 512 — ดู exportRes ใน placer.js)
    const wantedRes = () => (typeof exportRes === 'function' ? exportRes() : Number($('eRes').value) || SIZE);

    function hiResWanted() {
        return $('eHiPreview').checked && wantedRes() > SIZE;
    }

    /** ภาพลายความละเอียดสูงของชิ้นนั้น ถ้ายังตรงกับสถานะตอนนี้ */
    function hiResOf(part) {
        if (!hiRes || !hiResWanted() || hiRes.key !== stateKey() || hiRes.res !== wantedRes()) return null;
        return hiRes.parts[part] || null;
    }

    function scheduleHiRes() {
        clearTimeout(hiTimer);
        if (!hiResWanted()) {
            if (hiRes) { hiRes = null; releaseHiRes(); }
            return;
        }
        hiTimer = setTimeout(() => {
            if (ptr || !hiResWanted()) return scheduleHiRes();
            const res = wantedRes(), key = stateKey();
            if (hiRes && hiRes.key === key && hiRes.res === res) return;
            hiRes = { res, key, parts: {} };
            for (const part of PAINTABLE) hiRes.parts[part] = partImage(part, res);
            texDirty[S.gender] = true;
            schedule();
            render();
        }, 500);
    }

        // ───────────────────────────────────────── กล้อง ───────────────

    const cam = { yaw: FRONT, pitch: 0.06, dist: 2.4, tx: 0, ty: 0.25, tz: 0, ready: false };

    // ดูทั้งคู่: ชายยืนซ้าย หญิงยืนขวา (เลื่อนแค่ตอนวาด/คลิก ข้อมูลทุกอย่างยังอยู่ในพิกัดของโมเดลเอง)
    let both = false;
    const OFFSET = { male: [-0.5, 0, 0], female: [0.5, 0, 0] };
    const offsetOf = (g) => (both ? OFFSET[g] : [0, 0, 0]);
    const shownGenders = () => (both ? ['male', 'female'].filter((g) => DATA[g] && DATA[g].upper) : [S.gender]);
    let tween = null;
    let outline = true;

    function basis() {
        const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
        const z = [Math.sin(cam.yaw) * cp, sp, Math.cos(cam.yaw) * cp];     // จากเป้าไปหากล้อง
        const t = [cam.tx, cam.ty, cam.tz];
        const eye = add(t, z, cam.dist);
        const x = norm(cross([0, 1, 0], z));
        const y = cross(z, x);
        return { eye, x, y, z };
    }

    function matrix(aspect) {
        const { eye, x, y, z } = basis();
        const view = [
            x[0], y[0], z[0], 0,
            x[1], y[1], z[1], 0,
            x[2], y[2], z[2], 0,
            -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
        ];
        const near = 0.02, far = 30;
        const f = 1 / Math.tan(FOV / 2), nf = 1 / (near - far);
        const proj = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
        const out = new Float32Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                let s = 0;
                for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[c * 4 + k];
                out[c * 4 + r] = s;
            }
        }
        return { mvp: out, eye };
    }

    /** ระยะกล้องให้เห็นชิ้นส่วนที่เลือกเต็มจอ */
    function fit(names) {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const g of shownGenders()) {
            const B = body(g), off = offsetOf(g);
            for (const n of names) {
                const m = B[n];
                if (!m) continue;
                for (let k = 0; k < 3; k++) {
                    min[k] = Math.min(min[k], m.min[k] + off[k]);
                    max[k] = Math.max(max[k], m.max[k] + off[k]);
                }
            }
        }
        if (min[0] === Infinity) return {};
        const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight) || 1;
        const t = Math.tan(FOV / 2);
        const halfW = (max[0] - min[0]) / 2, halfH = (max[1] - min[1]) / 2;
        const dist = Math.max(halfH / t, halfW / (t * aspect)) * 1.1 + (max[2] - min[2]) / 2;
        return { dist, tx: (min[0] + max[0]) / 2, ty: (min[1] + max[1]) / 2, tz: (min[2] + max[2]) / 2 };
    }

    function goTo(goal) {
        const to = Object.assign({}, cam, goal);
        // หมุนทางที่ใกล้กว่า
        to.yaw = cam.yaw + mod(to.yaw - cam.yaw + Math.PI, Math.PI * 2) - Math.PI;
        tween = { from: Object.assign({}, cam), to, t0: performance.now() };
        schedule();
    }

    // ───────────────────────────────────────── วาด ─────────────────

    let raf = 0;
    const texDirty = { male: true, female: true };

    function shown() {
        return $('stageBody').dataset.layout !== 'uv' && canvas.clientWidth > 0;
    }

    function schedule(tex) {
        if (tex) texDirty.male = texDirty.female = true;
        if (!raf) raf = requestAnimationFrame(draw);
    }

    function draw() {
        raf = 0;
        if (!gl || !prog || !shown()) return;

        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

        if (!cam.ready) {
            Object.assign(cam, fit(['upper', 'head']), VIEWS.front);
            cam.ready = true;
        }
        if (tween) {
            const k = Math.min(1, (performance.now() - tween.t0) / 280);
            const e = 1 - Math.pow(1 - k, 3);
            for (const key of ['yaw', 'pitch', 'dist', 'tx', 'ty', 'tz']) {
                cam[key] = tween.from[key] + (tween.to[key] - tween.from[key]) * e;
            }
            if (k < 1) schedule(); else tween = null;
        }

        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.useProgram(prog);
        const { mvp, eye } = matrix(w / h);
        gl.uniformMatrix4fv(loc.uMvp, false, mvp);
        gl.uniform3fv(loc.uEye, eye);
        gl.uniform3fv(loc.uTint, tint);
        gl.uniform1i(loc.uTex, 0);
        gl.uniform1f(loc.uAlpha, 1);
        gl.activeTexture(gl.TEXTURE0);

        for (const g of shownGenders()) {
            const B = body(g);
            if (texDirty[g]) {
                for (const part of PAINTABLE) {
                    if (!B[part]) continue;
                    paintPart(part, g);
                    upload(glPart(g, B[part]).tex, paints[g][part]);
                }
                texDirty[g] = false;
            }
            gl.uniform3fv(loc.uOffset, offsetOf(g));
            drawBody(g, B);
        }
        drawOutfit();
    }

    function drawBody(g, B) {
        for (const name of PARTS) {
            const m = B[name];
            if (!m) continue;
            const G = glPart(g, m);
            const attrib = (where, buffer, size) => {
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                gl.enableVertexAttribArray(where);
                gl.vertexAttribPointer(where, size, gl.FLOAT, false, 0, 0);
            };
            attrib(loc.aPos, G.pos, 3);
            attrib(loc.aNrm, G.nrm, 3);
            attrib(loc.aUv, G.uv, 2);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, G.idx);
            gl.bindTexture(gl.TEXTURE_2D, G.tex);
            gl.drawElements(gl.TRIANGLES, m.idx.length, gl.UNSIGNED_SHORT, 0);
        }
    }

    // ───────────────────────────────────────── เสื้อผ้า / โมเดลเสริม ─
    // ดูอย่างเดียว (ไม่ลงลาย คลิกทะลุไปที่ผิว): ใส่เสื้อ / กางเกง / หมวก ดูว่าลายโผล่ตรงไหน
    // อ่าน .ydd.xml ที่ export จาก CodeX — ตำแหน่งจุดอยู่ระบบเดียวกับตัวละคร (ใช้ LodHigh)
    // texture: ชื่อ diffusetex ของแต่ละ shader → จับคู่กับ .ytd / .dds ที่ใส่มาด้วย (ไม่มี = สีเรียบ)

    const outfit = [];                   // { id, name, gender, visible, color, geoms: [{ pos, nrm, uv, idx, tex, gl }] }
    const outfitTex = {};                // ชื่อ texture ตัวเล็ก → { decode() → canvas, canvas }
    let outfitShow = true, outfitAlpha = 1, outfitNext = 1;
    const CLOTH = [118, 108, 96];

    /** .ydd.xml → [{ pos, nrm, uv, idx, tex }] ทุก drawable ในไฟล์ (LodHigh) */
    function parseYddXml(text) {
        const geoms = [];
        const starts = [];
        for (let i = text.indexOf('<ShaderGroup>'); i >= 0; i = text.indexOf('<ShaderGroup>', i + 1)) starts.push(i);
        if (!starts.length) throw new Error('ไม่ใช่ .ydd.xml ของ CodeX (ไม่มี ShaderGroup)');
        starts.push(text.length);
        for (let d = 0; d < starts.length - 1; d++) {
            const part = text.slice(starts[d], starts[d + 1]);
            const lodAt = part.indexOf('<LodHigh>');
            if (lodAt < 0) continue;
            // shader ตามลำดับ → ชื่อ texture สี
            const shaders = [];
            const shRe = /<Name>([^<]*)<\/Name>\s*<DrawBucket[\s\S]*?<\/Parameters>/g;
            const shaderPart = part.slice(0, lodAt);
            let m;
            while ((m = shRe.exec(shaderPart))) {
                const block = m[0];
                const t = block.match(/name="diffusetex"[^>]*texture="([^"]+)"/i)
                    || block.match(/texture="([^"]+_ab)"/i);
                shaders.push(t ? t[1].toLowerCase() : null);
            }
            const lod = part.slice(lodAt, part.indexOf('</LodHigh>', lodAt) + 10);
            const geoRe = /<ShaderID value="(\d+)"[\s\S]*?<Semantics>([^<]*)<\/Semantics>[\s\S]*?<Vertices>([\s\S]*?)<\/Vertices>\s*<Indices>([\s\S]*?)<\/Indices>/g;
            while ((m = geoRe.exec(lod))) {
                const [, sid, sem, vtx, ind] = m;
                const P = sem.indexOf('P'), N = sem.indexOf('N'), T = sem.indexOf('T');
                if (P < 0) continue;
                const lines = vtx.split('\n').map((l) => l.trim()).filter(Boolean);
                const n = lines.length;
                const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
                for (let i = 0; i < n; i++) {
                    const g = lines[i].split('\t');
                    const p = g[P].split(' ');
                    // เกมใช้ z ขึ้น → WebGL ใช้ y ขึ้น: (x, z, -y) แบบเดียวกับ build_model.py
                    pos[i * 3] = +p[0]; pos[i * 3 + 1] = +p[2]; pos[i * 3 + 2] = -p[1];
                    if (N >= 0) {
                        const q = g[N].split(' ');
                        nrm[i * 3] = +q[0]; nrm[i * 3 + 1] = +q[2]; nrm[i * 3 + 2] = -q[1];
                    } else nrm[i * 3 + 1] = 1;
                    if (T >= 0) {
                        const t = g[T].split(' ');
                        uv[i * 2] = +t[0]; uv[i * 2 + 1] = +t[1];
                    }
                }
                const list = ind.trim().split(/\s+/).map(Number);
                const big = n > 65535;
                if (big && !uintExt) throw new Error('โมเดลใหญ่เกินที่เบราว์เซอร์นี้วาดได้');
                geoms.push({ pos, nrm, uv, idx: big ? Uint32Array.from(list) : Uint16Array.from(list), tex: shaders[+sid] || null, gl: null });
            }
        }
        if (!geoms.length) throw new Error('ไม่พบโมเดลใน LodHigh');
        return geoms;
    }

    /** ใส่ texture จาก .ytd (ทุก texture ข้างใน) หรือ .dds / รูป — ใช้กับเสื้อผ้าที่ชื่อตรงกัน */
    async function addOutfitTextures(file) {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.ytd')) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const { virtualSize } = TattooYtd.readYtdHeader(bytes);
            const bodyBytes = await inflateRaw(bytes.subarray(16));
            for (const t of TattooYtd.parseYtd(bodyBytes, virtualSize)) {
                const key = t.name.toLowerCase();
                outfitTex[key] = {
                    decode() {
                        const rgba = TattooYtd.decodeTexture(bodyBytes, t);
                        const c = document.createElement('canvas');
                        c.width = t.w; c.height = t.h;
                        c.getContext('2d').putImageData(new ImageData(rgba, t.w, t.h), 0, 0);
                        return c;
                    },
                };
            }
        } else {
            const key = lower.replace(/\.(dds|png|jpe?g|webp)$/, '');
            const canvasP = readSkinFile(file);
            outfitTex[key] = { pending: canvasP };
            outfitTex[key].canvas = await canvasP;
        }
    }

    /** ผิวใน Tool ที่ชื่อตรงกับ texture นี้ (ชื่อตัวเล็ก) */
    function toolSkin(name) {
        if (!name) return null;
        for (const g of ['male', 'female']) {
            for (const part of PARTS) {
                const m = body(g)[part];
                const s = m && m.skins.find((x) => x.name.toLowerCase() === name);
                if (s) return s;
            }
        }
        return null;
    }

    const hasOutfitTex = (name) => !!(outfitTex[name] || toolSkin(name));

    /** texture ของชิ้นนั้น (canvas) หรือ null — ถอดครั้งแรกที่ใช้ */
    function outfitCanvas(name) {
        const t = name && outfitTex[name];
        if (!t) {
            // ชิ้นที่เป็นผิว (เช่นท่อนบนแบบใส่ใต้เสื้อ) ใช้ผิวที่ Tool มีอยู่แล้วถ้าชื่อตรงกัน
            const s = toolSkin(name);
            if (!s) return null;
            if (!s.img && s.url) {
                s.img = new Image();
                s.img.onload = () => { s.ready = true; schedule(); };
                s.img.src = s.url;
            }
            return s.ready ? s.img : null;
        }
        if (!t.canvas && t.decode && !t.failed) {
            try { t.canvas = t.decode(); } catch (err) { t.failed = true; toast(err.message, true); }
        }
        return t.canvas || null;
    }

    function outfitGl(item, geo) {
        if (geo.gl) return geo.gl;
        const buffer = (target, data) => {
            const b = gl.createBuffer();
            gl.bindBuffer(target, b);
            gl.bufferData(target, data, gl.STATIC_DRAW);
            return b;
        };
        geo.gl = {
            pos: buffer(gl.ARRAY_BUFFER, geo.pos),
            nrm: buffer(gl.ARRAY_BUFFER, geo.nrm),
            uv: buffer(gl.ARRAY_BUFFER, geo.uv),
            idx: buffer(gl.ELEMENT_ARRAY_BUFFER, geo.idx),
            tex: gl.createTexture(),
            texFrom: undefined,
        };
        return geo.gl;
    }

    /** ผูก texture ให้ชิ้นนั้น (เปลี่ยนเมื่อมีไฟล์ texture ใหม่ / เปลี่ยนสี) */
    function outfitBindTex(item, geo) {
        const G = outfitGl(item, geo);
        const img = outfitCanvas(geo.tex);
        const want = img ? 'img:' + geo.tex : 'color:' + item.color.join();
        if (G.texFrom !== want) {
            G.texFrom = want;
            if (img) upload(G.tex, img);
            else {
                gl.bindTexture(gl.TEXTURE_2D, G.tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...item.color, 255]));
                texParams(false);
            }
        }
        gl.bindTexture(gl.TEXTURE_2D, G.tex);
    }

    function drawOutfit() {
        if (!outfitShow || !outfit.length) return;
        const see = outfitAlpha < 0.999;
        if (see) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
        }
        gl.uniform1f(loc.uAlpha, outfitAlpha);
        for (const g of shownGenders()) {
            gl.uniform3fv(loc.uOffset, offsetOf(g));
            for (const item of outfit) {
                if (!item.visible || item.gender !== g) continue;
                for (const geo of item.geoms) {
                    const G = outfitGl(item, geo);
                    const attrib = (where, buffer, size) => {
                        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                        gl.enableVertexAttribArray(where);
                        gl.vertexAttribPointer(where, size, gl.FLOAT, false, 0, 0);
                    };
                    attrib(loc.aPos, G.pos, 3);
                    attrib(loc.aNrm, G.nrm, 3);
                    attrib(loc.aUv, G.uv, 2);
                    outfitBindTex(item, geo);
                    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, G.idx);
                    gl.drawElements(gl.TRIANGLES, geo.idx.length, geo.idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
                }
            }
        }
        gl.uniform1f(loc.uAlpha, 1);
        if (see) {
            gl.disable(gl.BLEND);
            gl.depthMask(true);
        }
    }

    /** เพศของไฟล์จากชื่อ: fr1 = หญิง · mr1 = ชาย · อื่น ๆ = เพศที่ดูอยู่ */
    const outfitGender = (name) => /fr1/i.test(name) ? 'female' : /mr1/i.test(name) ? 'male' : S.gender;

    async function addOutfitFiles(files) {
        const list = [...files];
        // texture ก่อน เสื้อผ้าที่ใส่พร้อมกันจะได้ใช้ทันที
        for (const f of list.filter((f) => !/\.xml$/i.test(f.name))) {
            try { await addOutfitTextures(f); } catch (err) { toast(`เปิด ${f.name} ไม่ได้: ${err.message}`, true); }
        }
        let added = 0, gender = null;
        for (const f of list.filter((f) => /\.xml$/i.test(f.name))) {
            try {
                const geoms = parseYddXml(await f.text());
                const name = f.name.replace(/\.ydd\.xml$|\.xml$/i, '');
                gender = outfitGender(name);
                outfit.push({ id: outfitNext++, name, gender, visible: true, color: CLOTH.slice(), geoms });
                added++;
            } catch (err) {
                toast(`เปิด ${f.name} ไม่ได้: ${err.message}`, true);
            }
        }
        if (gender && gender !== S.gender && !both) setGender(gender);
        refreshOutfitList();
        schedule();
        if (added) {
            const noTex = outfit.slice(-added).some((it) => it.geoms.some((g) => g.tex && !hasOutfitTex(g.tex)));
            toast(`ใส่เสื้อผ้า ${added} ชิ้น` + (noTex ? ' — บางชิ้นยังไม่มี texture (ใส่ .ytd ที่มีชื่อ texture นั้นเพิ่มได้ ไม่มีก็ใช้สีเรียบ)' : ''));
        } else if (list.length) {
            toast('ใส่ texture แล้ว');
        }
    }

    function refreshOutfitList() {
        const ul = $('outfitList');
        if (!ul) return;
        const GN = { male: 'ชาย', female: 'หญิง' };
        ul.innerHTML = outfit.map((it) => {
            const missing = it.geoms.filter((g) => g.tex && !hasOutfitTex(g.tex)).map((g) => g.tex);
            const tip = missing.length ? 'ยังไม่มี texture: ' + [...new Set(missing)].join(', ') : 'มี texture ครบ';
            return `<li data-id="${it.id}" class="${it.visible ? '' : 'off'}" title="${tip}">
                <span class="oname">${it.name.replace(/[<>&]/g, '')}<small>${GN[it.gender]}${missing.length ? ' · สีเรียบ' : ''}</small></span>
                <button data-act="eye" title="ซ่อน/แสดง">${it.visible ? '◉' : '○'}</button>
                <button data-act="del" title="เอาออก">✕</button>
            </li>`;
        }).join('');
        $('outfitEmpty').classList.toggle('hidden', outfit.length > 0);
    }

    function setupOutfitUi() {
        if (!$('btnOutfitAdd')) return;
        $('btnOutfitAdd').addEventListener('click', () => $('fileOutfit').click());
        $('fileOutfit').addEventListener('change', (e) => { addOutfitFiles(e.target.files); e.target.value = ''; });
        $('outfitList').addEventListener('click', (e) => {
            const b = e.target.closest('button');
            const li = e.target.closest('li');
            if (!b || !li) return;
            const i = outfit.findIndex((it) => it.id === Number(li.dataset.id));
            if (i < 0) return;
            if (b.dataset.act === 'eye') outfit[i].visible = !outfit[i].visible;
            if (b.dataset.act === 'del') {
                for (const geo of outfit[i].geoms) {
                    if (!geo.gl) continue;
                    for (const k of ['pos', 'nrm', 'uv', 'idx']) gl.deleteBuffer(geo.gl[k]);
                    gl.deleteTexture(geo.gl.tex);
                }
                outfit.splice(i, 1);
            }
            refreshOutfitList();
            schedule();
        });
        $('outfitShow').addEventListener('change', (e) => { outfitShow = e.target.checked; schedule(); });
        $('outfitAlpha').addEventListener('input', (e) => {
            outfitAlpha = Number(e.target.value) / 100;
            $('outfitAlphaV').textContent = e.target.value + '%';
            schedule();
        });
        $('outfitColor').addEventListener('input', (e) => {
            const v = e.target.value;
            const c = [1, 3, 5].map((k) => parseInt(v.slice(k, k + 2), 16));
            for (const it of outfit) it.color = c;
            CLOTH.splice(0, 3, ...c);
            schedule();
        });
        refreshOutfitList();
    }

    // ───────────────────────────────────────── คลิกบนตัว ───────────

    /** เส้นจากกล้องผ่านตำแหน่งเมาส์ */
    function ray(e) {
        const r = canvas.getBoundingClientRect();
        const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
        const ny = 1 - ((e.clientY - r.top) / r.height) * 2;
        const b = basis();
        const { x, y, z } = b;
        const t = Math.tan(FOV / 2), aspect = r.width / r.height;
        b.d = norm([
            -z[0] + (x[0] * nx * aspect + y[0] * ny) * t,
            -z[1] + (x[1] * nx * aspect + y[1] * ny) * t,
            -z[2] + (x[2] * nx * aspect + y[2] * ny) * t,
        ]);
        return b;
    }

    /** จุดแรกบนตัวที่เมาส์ชี้ */
    function pick(e) {
        const { eye, d } = ray(e);
        let best = null;
        for (const g of shownGenders()) {
            const h = castBody(add(eye, offsetOf(g), -1), d, g);
            if (h && (!best || h.t < best.t)) best = h;
        }
        return best;
    }

    /** ดูทั้งคู่: คลิกตัวไหนก็แก้ตัวนั้น */
    function focusHit(h) {
        if (h && h.g && h.g !== S.gender) setGender(h.g);
    }

    /** จุดนั้นมีหมึกของเลเยอร์แบบบนภาพ UV จริงไหม (ไม่ใช่แค่ในกรอบ) */
    function inkAt(L, px, py) {
        if (!L.maskData) L.maskData = L.mask.getContext('2d').getImageData(0, 0, L.w, L.h).data;
        const r = -L.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        const reach = 3 / L.scale;            // เผื่อ ~3 พิกเซลของภาพ
        for (const [ox, oy] of offsets()) {
            const dx = px - (L.x + ox), dy = py - (L.y + oy);
            let lx = (dx * c - dy * s) / (L.scale * L.sx), ly = (dx * s + dy * c) / (L.scale * L.sy);
            if (L.flipX) lx = -lx;
            if (L.flipY) ly = -ly;
            lx += L.w / 2;
            ly += L.h / 2;
            for (let j = -2; j <= 2; j++) {
                for (let i = -2; i <= 2; i++) {
                    const ix = Math.floor(lx + i * reach / 2), iy = Math.floor(ly + j * reach / 2);
                    if (ix >= 0 && iy >= 0 && ix < L.w && iy < L.h && L.maskData[(iy * L.w + ix) * 4 + 3] > 24) return true;
                }
            }
        }
        return false;
    }

    /** เลเยอร์บนสุดที่มีหมึกตรงจุดนั้น — คลิกผิวเปล่าจะได้หมุนกล้องแทน */
    function layerAt(px, py, part) {
        for (let i = S.layers.length - 1; i >= 0; i--) {
            const L = S.layers[i];
            if (!L.visible || !forGender(L)) continue;
            if (L.place !== 'uv' ? bakedHit(L, px, py, part) : partOf(L) === part && inkAt(L, px, py)) return L;
        }
        return null;
    }

    function place(L, x, y, part) {
        L.x = S.wrapX ? mod(x, SIZE) : x;
        L.y = S.wrapY ? mod(y, SIZE) : y;
        if (part) L.part = part;
    }

    /** ลากลายติดบนตัว: จุดที่จับไว้ตามเมาส์ไปบนผิว ข้ามรอยต่อ / ข้ามท่อนบน-ขาได้ต่อเนื่อง */
    function dragOnBody(st, h) {
        const m = body(S.gender)[h.part];
        const n = smoothNormal(m, h.p, st.radius, h.n);
        const { T, U } = tangentFrame(n);
        const target = add(add(h.p, T, -st.ga), U, -st.gb);
        const on = anchorFrom(add(target, n, 0.08), neg(n));
        if (on) place(st.L, on.x, on.y, on.part);
        else place(st.L, h.px, h.py, h.part);
    }

    let ptr = null;
    let hoverEvent = null, hoverRaf = 0;

    /** วงแปรงยางลบบนจอ (ขนาดตามระยะจากกล้อง) */
    function brushRing(e, h) {
        if (!h || !h.paint) return hideBrush();
        const dist = Math.hypot(...add(add(h.p, offsetOf(h.g)), basis().eye, -1));
        const r = (brush.size / 100) / (dist * 2 * Math.tan(FOV / 2)) * canvas.clientHeight;
        showBrush(e.clientX, e.clientY, r);
    }

    function hover(e) {
        hoverEvent = e;
        if (hoverRaf) return;
        hoverRaf = requestAnimationFrame(() => {
            hoverRaf = 0;
            if (ptr) return;
            const h = pick(hoverEvent);
            if (S.tool !== 'move') brushRing(hoverEvent, h);
            const mine = h && h.g === S.gender;
            canvas.style.cursor = h && h.paint ? (!mine ? 'pointer' : layerAt(h.px, h.py, h.part) ? 'grab' : 'crosshair') : '';
            const who = both && h ? (h.g === 'male' ? 'ชาย · ' : 'หญิง · ') : '';
            $('bodyCoord').textContent = !h ? ''
                : !mine ? who + 'คลิกเพื่อแก้ตัวนี้'
                : h.paint ? `${who}ผิว${PART_NAME[h.part]} · X ${Math.round(h.px)} Y ${Math.round(h.py)}`
                : who + 'หัว / คอ — ผิวหัวถูก murphy สร้าง ลายลงไม่ได้';
        });
    }

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
        tween = null;
        canvas.setPointerCapture(e.pointerId);
        if (e.button === 0 && S.tool !== 'move') {
            // ยางลบ / แปรงคืนลาย: ลากบนผิว = ลบ, ลากที่ว่าง = หมุนกล้อง
            const h = pick(e);
            focusHit(h);
            if (h && h.paint) {
                const L = selected();
                if (!L) { toast('เลือกเลเยอร์ที่จะลบก่อน', true); return; }
                beginStroke(L);
                paintAt(h.part, h.px, h.py);
                ptr = { mode: 'paint' };
                return;
            }
            ptr = { mode: 'orbit', x: e.clientX, y: e.clientY };
            return;
        }
        if (e.button === 0) {
            const h = pick(e);
            focusHit(h);
            const L = h && h.paint ? layerAt(h.px, h.py, h.part) : null;
            if (e.altKey && L) {
                splitLayer(L, { part: h.part, x: h.px, y: h.py });
                return;
            }
            if (L) {
                checkpoint();
                S.sel = L;
                ptr = { mode: 'layer', L, dx: L.x - h.px, dy: L.y - h.py };
                if (L.place !== 'uv') {
                    const F = bake(L).frame;
                    if (F) {
                        const d = add(h.p, F.p, -1);
                        Object.assign(ptr, { body: true, ga: dot(d, F.T), gb: dot(d, F.U), radius: clamp(F.span * 0.3, 0.015, 0.09) });
                    }
                }
                canvas.style.cursor = 'grabbing';
                refreshAll();
                return;
            }
            ptr = { mode: 'orbit', x: e.clientX, y: e.clientY };
        } else {
            ptr = { mode: 'pan', x: e.clientX, y: e.clientY };
        }
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!ptr) return hover(e);
        if (ptr.mode === 'paint') {
            const h = pick(e);
            brushRing(e, h);
            if (h && h.paint && h.g === S.gender) paintAt(h.part, h.px, h.py);
            return;
        }
        if (ptr.mode === 'layer') {
            const h = pick(e);
            if (!h || !h.paint || h.g !== S.gender) return;
            if (ptr.body) dragOnBody(ptr, h);
            else if (h.part === partOf(ptr.L)) place(ptr.L, h.px + ptr.dx, h.py + ptr.dy);
            else return;
            render();
            syncProps();
            return;
        }
        const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
        ptr.x = e.clientX;
        ptr.y = e.clientY;
        if (ptr.mode === 'orbit') {
            cam.yaw -= dx * 0.008;
            cam.pitch = clamp(cam.pitch + dy * 0.006, -1.3, 1.3);
        } else {
            const { x, y } = basis();
            const k = cam.dist * Math.tan(FOV / 2) * 2 / Math.max(1, canvas.clientHeight);
            cam.tx += (-x[0] * dx + y[0] * dy) * k;
            cam.ty += (-x[1] * dx + y[1] * dy) * k;
            cam.tz += (-x[2] * dx + y[2] * dy) * k;
        }
        schedule();
    });

    const endDrag = () => {
        // ล้าง ptr ก่อน — วาดรอบสุดท้ายจะได้ทำ "คมขึ้น" ที่ข้ามไปตอนกำลังลาก (BodyView.busy)
        const was = ptr;
        ptr = null;
        canvas.style.cursor = '';
        if (was && was.mode === 'paint') endStroke();
        if (was && was.mode === 'layer') refreshAll();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', () => { if (!ptr) { $('bodyCoord').textContent = ''; hideBrush(); } });

    // ดับเบิลคลิกบนตัว = ย้ายลายที่เลือกมาตรงนั้น
    canvas.addEventListener('dblclick', (e) => {
        const h = pick(e);
        if (!h) return;
        focusHit(h);
        if (!h.paint) return toast('หัว / คอ ลงลายไม่ได้ — ผิวหัวถูก murphy สร้าง', true);
        const L = selected();
        if (!L) return toast('เลือกเลเยอร์ก่อน แล้วดับเบิลคลิกบนตัวเพื่อย้ายลายมาตรงนั้น', true);
        if (S.tool !== 'move') return;
        checkpoint();
        place(L, h.px, h.py, h.part);
        refreshAll();
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        let delta = e.deltaY || e.deltaX;
        if (!delta) return;
        if (e.deltaMode === 1) delta *= 33;          // บางเบราว์เซอร์ส่งเป็นบรรทัด
        const dir = delta < 0 ? 1 : -1;
        const L = selected();
        if (L && (e.shiftKey || e.ctrlKey)) {
            checkpointBurst();
            if (e.ctrlKey) L.rot = mod(L.rot + dir * (e.altKey ? 1 : 5) + 180, 360) - 180;
            else L.scale = clamp(L.scale * (1 + dir * (e.altKey ? 0.01 : 0.05)), 0.02, 8);
            render();
            syncProps();
            return;
        }
        // ซูมเข้าหาจุดที่เมาส์ชี้ (จุดนั้นอยู่ที่เดิมบนจอ)
        tween = null;
        const { eye, z, d } = ray(e);
        const f = clamp(cam.dist * Math.exp(clamp(delta, -300, 300) * 0.0015), 0.25, 6) / cam.dist;
        const reach = cam.dist / Math.max(0.2, -dot(d, z));
        const P = add(eye, d, reach);
        cam.tx = P[0] + (cam.tx - P[0]) * f;
        cam.ty = P[1] + (cam.ty - P[1]) * f;
        cam.tz = P[2] + (cam.tz - P[2]) * f;
        cam.dist *= f;
        schedule();
    }, { passive: false });

    // ───────────────────────────────────────── ผิวของโมเดล ─────────

    const DXGI = {
        70: 'bc1', 71: 'bc1', 72: 'bc1', 73: 'bc2', 74: 'bc2', 75: 'bc2', 76: 'bc3', 77: 'bc3', 78: 'bc3',
        28: 'rgba', 29: 'rgba', 87: 'bgra', 91: 'bgra',
    };

    /** mip แรกของไฟล์ DDS → { w, h, rgba } รองรับ BC1 / BC2 / BC3 / RGBA 8 บิต */
    function decodeDds(buf) {
        const dv = new DataView(buf), u8 = new Uint8Array(buf);
        if (dv.getUint32(0, true) !== 0x20534444) throw new Error('ไม่ใช่ไฟล์ DDS');
        const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
        const four = String.fromCharCode(u8[84], u8[85], u8[86], u8[87]);
        let start = 128, fmt = null;
        if (four === 'DX10') {
            const dxgi = dv.getUint32(128, true);
            start = 148;
            fmt = DXGI[dxgi];
            if (!fmt) throw new Error(`DDS แบบ DXGI ${dxgi} ยังไม่รองรับ (ได้แค่ BC1 / BC2 / BC3 / RGBA) — แปลงเป็น PNG ก่อน`);
        } else if (four === 'DXT1') fmt = 'bc1';
        else if (four === 'DXT2' || four === 'DXT3') fmt = 'bc2';
        else if (four === 'DXT4' || four === 'DXT5') fmt = 'bc3';
        else if ((dv.getUint32(80, true) & 0x40) && dv.getUint32(88, true) === 32) fmt = dv.getUint32(92, true) === 0xff ? 'rgba' : 'bgra';
        else throw new Error('DDS แบบนี้ยังไม่รองรับ — แปลงเป็น PNG ก่อน');

        const out = new Uint8ClampedArray(w * h * 4);
        if (fmt === 'rgba' || fmt === 'bgra') {
            out.set(u8.subarray(start, start + out.length));
            if (fmt === 'bgra') for (let i = 0; i < out.length; i += 4) { const t = out[i]; out[i] = out[i + 2]; out[i + 2] = t; }
            return { w, h, rgba: out };
        }

        const size = fmt === 'bc1' ? 8 : 16, bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
        const alpha = new Uint8Array(16), pal = new Uint8Array(16);
        const c565 = (v, k) => {
            pal[k * 4] = ((v >> 11) & 31) * 255 / 31;
            pal[k * 4 + 1] = ((v >> 5) & 63) * 255 / 63;
            pal[k * 4 + 2] = (v & 31) * 255 / 31;
        };
        for (let by = 0; by < bh; by++) {
            for (let bx = 0; bx < bw; bx++) {
                let o = start + (by * bw + bx) * size;
                alpha.fill(255);
                if (fmt === 'bc2') {
                    for (let i = 0; i < 16; i++) alpha[i] = ((u8[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
                    o += 8;
                } else if (fmt === 'bc3') {
                    const a0 = u8[o], a1 = u8[o + 1], t = [a0, a1];
                    if (a0 > a1) for (let k = 1; k < 7; k++) t.push(((7 - k) * a0 + k * a1) / 7 | 0);
                    else { for (let k = 1; k < 5; k++) t.push(((5 - k) * a0 + k * a1) / 5 | 0); t.push(0, 255); }
                    for (let half = 0; half < 2; half++) {
                        const q = o + 2 + half * 3;
                        const bits = u8[q] | (u8[q + 1] << 8) | (u8[q + 2] << 16);
                        for (let i = 0; i < 8; i++) alpha[half * 8 + i] = t[(bits >> (3 * i)) & 7];
                    }
                    o += 8;
                }
                const c0 = u8[o] | (u8[o + 1] << 8), c1 = u8[o + 2] | (u8[o + 3] << 8);
                const bits = (u8[o + 4] | (u8[o + 5] << 8) | (u8[o + 6] << 16) | (u8[o + 7] << 24)) >>> 0;
                const punch = fmt === 'bc1' && c0 <= c1;
                c565(c0, 0);
                c565(c1, 1);
                for (let k = 0; k < 3; k++) {
                    if (punch) {
                        pal[8 + k] = (pal[k] + pal[4 + k]) / 2;
                        pal[12 + k] = 0;
                    } else {
                        pal[8 + k] = (2 * pal[k] + pal[4 + k]) / 3;
                        pal[12 + k] = (pal[k] + 2 * pal[4 + k]) / 3;
                    }
                }
                for (let i = 0; i < 16; i++) {
                    const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
                    if (x >= w || y >= h) continue;
                    const k = (bits >>> (2 * i)) & 3, q = (y * w + x) * 4;
                    out[q] = pal[k * 4];
                    out[q + 1] = pal[k * 4 + 1];
                    out[q + 2] = pal[k * 4 + 2];
                    out[q + 3] = punch && k === 3 ? 0 : alpha[i];
                }
            }
        }
        return { w, h, rgba: out };
    }

    /** ไฟล์ผิว (.dds / .png / .jpg) → canvas จัตุรัสขนาด 2^n (WebGL ต้องใช้ทำ mipmap / วนขอบ) */
    /** ภาพจัตุรัสขนาด 2 ยกกำลัง (64-2048) — WebGL ทำ mipmap / วนขอบได้ */
    function squareCanvas(src, w, h) {
        const n = clamp(Math.pow(2, Math.round(Math.log2(Math.max(w, h)))), 64, 2048);
        const c = document.createElement('canvas');
        c.width = c.height = n;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, n, n);
        return c;
    }

    /** .ytd → ผิวทุกอันในไฟล์ [{ name, canvas }] (ข้าม normal / material) */
    async function readYtdSkins(f) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const { virtualSize } = TattooYtd.readYtdHeader(bytes);
        const bodyBytes = await inflateRaw(bytes.subarray(16));
        const all = TattooYtd.parseYtd(bodyBytes, virtualSize);
        let picks = all.filter((x) => !/_(nm|ma|mb|mt|hm|sk|n|m)$/i.test(x.name));
        if (!picks.length) picks = all;
        if (!picks.length) throw new Error('ไม่มี texture ในไฟล์');
        const out = [];
        for (const t of picks) {
            const src = document.createElement('canvas');
            src.width = t.w;
            src.height = t.h;
            src.getContext('2d').putImageData(new ImageData(TattooYtd.decodeTexture(bodyBytes, t), t.w, t.h), 0, 0);
            out.push({ name: t.name, canvas: squareCanvas(src, t.w, t.h) });
        }
        return out;
    }

    /** ไฟล์ผิว .dds / รูป → canvas (.ytd ใช้ readYtdSkins) */
    async function readSkinFile(f) {
        let src, w, h;
        if (/\.ytd$/i.test(f.name)) return (await readYtdSkins(f))[0].canvas;
        if (/\.dds$/i.test(f.name)) {
            const d = decodeDds(await f.arrayBuffer());
            src = document.createElement('canvas');
            src.width = w = d.w;
            src.height = h = d.h;
            src.getContext('2d').putImageData(new ImageData(d.rgba, d.w, d.h), 0, 0);
        } else {
            const url = URL.createObjectURL(f);
            try { src = await loadImage(url); } finally { URL.revokeObjectURL(url); }
            w = src.naturalWidth;
            h = src.naturalHeight;
        }
        return squareCanvas(src, w, h);
    }

    function fillSkinSelects() {
        const g = S.gender, B = body(g);
        for (const part of PARTS) {
            const sel = $(SKIN_SELECT[part]);
            const m = B[part];
            sel.innerHTML = '';
            sel.disabled = !m;
            if (!m) continue;
            for (const s of m.skins) sel.add(new Option(s.name + (s.user ? ' (ไฟล์ที่โหลดเอง)' : ''), s.name));
            if (!m.skins.length) sel.add(new Option('— ไม่มีไฟล์ผิว (ใช้สีเรียบ) —', ''));
            sel.add(new Option('+ โหลดไฟล์ผิวเอง… (.dds / .png)', '__file'));
            sel.value = skinSel[g][part] || '';
        }
    }

    function updateNote() {
        const g = S.gender;
        const up = body(g).upper;
        const missing = !up.skins.length || !skinSel[g].upper;
        $('bodyNote').textContent = missing
            ? `ยังไม่มีไฟล์ผิวท่อนบนของ${g === 'male' ? 'ผู้ชาย' : 'ผู้หญิง'} — ใช้สีผิวเรียบแทน (เลือก / โหลดไฟล์ได้ที่ "ตัวโมเดล 3D" ทางซ้าย)`
            : '';
        $('bodyNote').classList.toggle('hidden', !missing);
    }

    PARTS.forEach((part) => {
        const sel = $(SKIN_SELECT[part]);
        sel.addEventListener('change', () => {
            const g = S.gender;
            if (sel.value === '__file') {
                sel.value = skinSel[g][part] || '';
                $('fileSkin').dataset.part = part;
                $('fileSkin').click();
                return;
            }
            skinSel[g][part] = sel.value;
            skinOf(g, part);
            skinChanged(g, part);
        });
    });

    $('fileSkin').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        const part = e.target.dataset.part;
        e.target.value = '';
        if (!f || !part) return;
        try {
            const g = S.gender, m = body(g)[part];
            // .ytd อาจมีผิวหลายอัน (หลายสีผิว / หลายส่วน) — ใส่ทุกอันในรายการ เลือกอันที่ตรงเพศ+ส่วนนี้ให้ก่อน
            const found = /\.ytd$/i.test(f.name)
                ? await readYtdSkins(f)
                : [{ name: f.name.replace(/\.[^.]+$/, ''), canvas: await readSkinFile(f) }];
            const KEY = { upper: /hand|uppertorso/i, lower: /feet|lowertorso|legs/i, head: /head/i };
            const sex = g === 'male' ? /mr1/i : /fr1/i;
            const score = (n) => (KEY[part].test(n) ? 2 : 0) + (sex.test(n) ? 1 : 0);
            let best = null;
            for (const x of found) {
                let name = x.name;
                while (m.skins.some((s) => s.name === name)) name += '+';
                m.skins.push({ name, img: x.canvas, ready: true, user: true });
                if (!best || score(x.name) > best.score) best = { name, score: score(x.name) };
            }
            skinSel[g][part] = best.name;
            fillSkinSelects();
            skinChanged(g, part);
            toast(found.length > 1
                ? `เพิ่มผิว ${found.length} อันจาก ${f.name} — ใช้ ${best.name} (เลือกอันอื่นได้ในรายการ)`
                : `ใช้ผิว ${best.name} แล้ว`);
        } catch (err) {
            toast('เปิดไฟล์ผิวไม่ได้: ' + err.message, true);
        }
    });

    function setTint(hex) {
        const v = parseInt(hex.slice(1), 16);
        tint = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
        schedule();
    }

    $('skinTint').addEventListener('input', (e) => setTint(e.target.value));
    $('skinTintReset').addEventListener('click', () => { $('skinTint').value = '#ffffff'; setTint('#ffffff'); });

    // ───────────────────────────────────────── ปุ่ม ────────────────

    function setLayout(layout) {
        $('stageBody').dataset.layout = layout;
        document.querySelectorAll('#layoutSeg button').forEach((b) => b.classList.toggle('active', b.dataset.l === layout));
        layoutView();
        render();
        schedule(true);
    }

    /** ภาพ UV ที่แสดงในพื้นที่ 2D: ท่อนบน / ขา */
    function setUvPart(part) {
        S.uvPart = part;
        document.querySelectorAll('#uvPartSeg button').forEach((b) => b.classList.toggle('active', b.dataset.p === part));
        refreshAll();
    }

    function setGender(g) {
        if (!DATA[g] || !DATA[g].upper) return;
        if (g !== S.gender) {
            // แต่ละเพศมีท่าของตัวเอง — ครั้งแรกตั้งต้นจากจุดเดียวกันบนตัว หลังจากนั้นปรับแยกกัน
            for (const L of S.layers) ensurePose(L, g);
            for (const L of S.layers) {
                L.poses[S.gender] = poseOf(L);
                Object.assign(L, L.poses[g]);
            }
            S.gender = g;
        }
        document.querySelectorAll('#genderSeg button').forEach((b) => b.classList.toggle('active', b.dataset.g === g));
        PARTS.forEach((part) => skinOf(g, part));
        fillSkinSelects();
        updateNote();
        if ($('steppers').childElementCount) refreshAll(); else render();
        schedule(true);
    }

    $('layoutSeg').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (b) setLayout(b.dataset.l);
    });

    $('uvPartSeg').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (b) setUvPart(b.dataset.p);
    });

    function setBoth(on) {
        both = !!on;
        $('bothToggle').classList.toggle('on', both);
        schedule(true);
        goTo(fit(['upper', 'head']));
    }

    $('bothToggle').addEventListener('click', () => setBoth(!both));
    $('eHiPreview').addEventListener('change', () => { scheduleHiRes(); schedule(true); render(); });
    $('eRes').addEventListener('change', () => { scheduleHiRes(); schedule(true); render(); });

    /** ตั้งเพศที่กำลังแก้ตรง ๆ (ใช้ตอนเลิกทำ — ค่าบนเลเยอร์เป็นของเพศนั้นอยู่แล้ว) */
    function setGenderRaw(g) {
        S.gender = g;
        document.querySelectorAll('#genderSeg button').forEach((b) => b.classList.toggle('active', b.dataset.g === g));
        fillSkinSelects();
        updateNote();
        schedule(true);
    }

    $('genderSeg').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (b) setGender(b.dataset.g);
    });
    ['male', 'female'].forEach((g) => {
        const b = document.querySelector(`#genderSeg button[data-g="${g}"]`);
        if (b && !(DATA[g] && DATA[g].upper)) b.disabled = true;
    });

    $('bodyViews').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const v = b.dataset.v;
        if (VIEWS[v]) goTo(VIEWS[v]);
        else if (v === 'torso') goTo(fit(['upper', 'head']));
        else if (v === 'legs') goTo(fit(['lower']));
        else if (v === 'full') goTo(fit(PARTS));
    });

    $('bodyOutline').addEventListener('change', (e) => { outline = e.target.checked; schedule(true); });
    $('uvGuide').addEventListener('change', (e) => { S.uvGuide = e.target.checked; render(); });

    new ResizeObserver(() => schedule()).observe(canvas);

    if (!gl) {
        $('bodyNote').textContent = 'เบราว์เซอร์นี้เปิด WebGL ไม่ได้ — ดูได้แค่ภาพ UV';
        $('bodyNote').classList.remove('hidden');
    } else {
        try {
            setupGl();
        } catch (err) {
            $('bodyNote').textContent = 'สร้างตัว 3D ไม่ได้: ' + err.message;
            $('bodyNote').classList.remove('hidden');
        }
    }

    setGender(DATA[S.gender] && DATA[S.gender].upper ? S.gender : (DATA.male && DATA.male.upper ? 'male' : 'female'));
    setupOutfitUi();

    return {
        PAINTABLE,
        busy: () => !!ptr,          // กำลังลากบนตัว 3D
        drawUvGuide,
        setGender,
        setLayout,
        setUvPart,
        bake,
        bakeFor,
        bakeAt,
        inGender,
        ensurePose,
        copyPoseFromOther,
        setGenderRaw,
        snapshot,
        hiResOf,
        releaseHiRes,
        texelIslands,
        bakedHit,
        defaultAnchor,
        defaultScale,
        mirrorAnchor,
        imageAtTexel,
        cameraFrame,
        metersPerPixel: (part = 'upper') => surface(S.gender, part).mpp,
        update: () => { schedule(true); scheduleHiRes(); },
    };
})();
