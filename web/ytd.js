/* =====================================================================
   สร้างไฟล์ .ytd (RDR2 / RSC8) ของลายสัก — ใช้ได้ทั้งในเบราว์เซอร์และ node
   โครงไฟล์ลอกจาก overlay_hand_coyote.ytd ของโพสต์ forum (ไฟล์ที่ใช้ในเกมได้จริง)
   ทุก byte — ทดสอบด้วย tools/placer/test_ytd.js ว่าสร้าง coyote ใหม่ได้ตรงต้นฉบับ

   ไฟล์ <name>.ytd มี 2 texture:
     <name>_ab  512x512 BC3 (DXT5) 10 mips — ลายเป็นสีเขียว (0,125,0) + alpha
                (ลายสี: สีจริง + alpha · ขนาด 1024 / 2048 ได้ — mips ถึง 1x1 เหมือนกัน)
     <name>_ma  512x512 BC1 (DXT1)  8 mips — material (ใช้ของเดิมทุกลาย)
   ===================================================================== */
(function (root) {
    'use strict';

    const FMT_BC1 = 0x47;
    const FMT_BC3 = 0x4d;
    const VIRTUAL_SIZE = 0x2000;
    const INK_565 = (0 << 11) | (31 << 5) | 0;     // (0,125,0) แบบ RGB565 เหมือนไฟล์เดิม

    function joaat(str) {
        let h = 0;
        const s = String(str).toLowerCase();
        for (let i = 0; i < s.length; i++) {
            h = (h + s.charCodeAt(i)) >>> 0;
            h = (h + (h << 10)) >>> 0;
            h = (h ^ (h >>> 6)) >>> 0;
        }
        h = (h + (h << 3)) >>> 0;
        h = (h ^ (h >>> 11)) >>> 0;
        h = (h + (h << 15)) >>> 0;
        return h;
    }

    // ───────────────────────────────────────────── BC3 (DXT5) ─────────

    /** บีบ alpha 16 ค่าของบล็อก 4x4 เป็น 8 byte (BC4) */
    function encodeAlphaBlock(a, out, o) {
        let lo = 255, hi = 0;
        for (let i = 0; i < 16; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
        out[o] = hi;
        out[o + 1] = lo;
        if (hi === lo) { for (let k = 2; k < 8; k++) out[o + k] = 0; return; }

        // โหมด 8 ระดับ (a0 > a1): 0=hi 1=lo 2..7 = ไล่จาก hi ไป lo
        const pal = [hi, lo];
        for (let k = 1; k <= 6; k++) pal.push(Math.floor(((7 - k) * hi + k * lo) / 7));
        let bits = 0n;
        for (let i = 0; i < 16; i++) {
            let best = 0, bestD = 1e9;
            for (let k = 0; k < 8; k++) {
                const d = Math.abs(pal[k] - a[i]);
                if (d < bestD) { bestD = d; best = k; }
            }
            bits |= BigInt(best) << BigInt(3 * i);
        }
        for (let k = 0; k < 6; k++) out[o + 2 + k] = Number((bits >> BigInt(8 * k)) & 0xffn);
    }

    /** alpha (Uint8Array w*h) → BC3 ทั้งรูป สีคงที่ (0,125,0) */
    function encodeBC3(alpha, w, h) {
        const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
        const out = new Uint8Array(bw * bh * 16);
        const a = new Uint8Array(16);
        for (let by = 0; by < bh; by++) {
            for (let bx = 0; bx < bw; bx++) {
                for (let i = 0; i < 16; i++) {
                    const x = Math.min(w - 1, bx * 4 + (i & 3));
                    const y = Math.min(h - 1, by * 4 + (i >> 2));
                    a[i] = alpha[y * w + x];
                }
                const o = (by * bw + bx) * 16;
                encodeAlphaBlock(a, out, o);
                // บล็อกสี: สองปลายเป็นสีเดียวกัน ดัชนีทั้งหมด = 0
                out[o + 8] = INK_565 & 0xff; out[o + 9] = INK_565 >> 8;
                out[o + 10] = INK_565 & 0xff; out[o + 11] = INK_565 >> 8;
            }
        }
        return out;
    }

    // ───────────────────────────────────────────── BC3 สีจริง ─────────

    const to565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    const from565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];

    /** บล็อกสี 4x4 (16 พิกเซล rgb + alpha) → 8 byte แบบ BC1 สี่ระดับ (ใน BC3 ใช้สี่ระดับเสมอ) */
    function encodeColorBlock(rgb, a, out, o) {
        const lo = [255, 255, 255], hi = [0, 0, 0];
        let count = 0;
        for (let i = 0; i < 16; i++) {
            if (a[i] < 8) continue;                         // พิกเซลใสไม่มีผลกับสี
            count++;
            for (let k = 0; k < 3; k++) {
                const v = rgb[i * 3 + k];
                if (v < lo[k]) lo[k] = v;
                if (v > hi[k]) hi[k] = v;
            }
        }
        if (!count) { for (let k = 0; k < 8; k++) out[o + k] = 0; return; }
        // หดกรอบสีเข้าเล็กน้อย (แบบ stb_dxt) ให้สีกลางแม่นขึ้น
        for (let k = 0; k < 3; k++) {
            const inset = (hi[k] - lo[k]) >> 4;
            lo[k] = Math.min(255, lo[k] + inset);
            hi[k] = Math.max(0, hi[k] - inset);
        }
        let c0 = to565(hi[0], hi[1], hi[2]), c1 = to565(lo[0], lo[1], lo[2]);
        if (c0 < c1) [c0, c1] = [c1, c0];
        const p0 = from565(c0), p1 = from565(c1);
        const pal = [p0, p1,
            [0, 1, 2].map((k) => (2 * p0[k] + p1[k]) / 3),
            [0, 1, 2].map((k) => (p0[k] + 2 * p1[k]) / 3)];
        let bits = 0;
        if (c0 !== c1) {
            for (let i = 0; i < 16; i++) {
                if (a[i] < 8) continue;
                let best = 0, bestD = Infinity;
                for (let k = 0; k < 4; k++) {
                    const dr = pal[k][0] - rgb[i * 3], dg = pal[k][1] - rgb[i * 3 + 1], db = pal[k][2] - rgb[i * 3 + 2];
                    const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
                    if (d < bestD) { bestD = d; best = k; }
                }
                bits |= best << (2 * i);
            }
        }
        out[o] = c0 & 0xff; out[o + 1] = c0 >> 8;
        out[o + 2] = c1 & 0xff; out[o + 3] = c1 >> 8;
        bits >>>= 0;
        out[o + 4] = bits & 0xff; out[o + 5] = (bits >>> 8) & 0xff;
        out[o + 6] = (bits >>> 16) & 0xff; out[o + 7] = (bits >>> 24) & 0xff;
    }

    /** rgba (w*h*4) → BC3 ทั้งรูป สีจริง */
    function encodeBC3RGBA(rgba, w, h) {
        const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
        const out = new Uint8Array(bw * bh * 16);
        const a = new Uint8Array(16), rgb = new Uint8Array(48);
        for (let by = 0; by < bh; by++) {
            for (let bx = 0; bx < bw; bx++) {
                for (let i = 0; i < 16; i++) {
                    const x = Math.min(w - 1, bx * 4 + (i & 3));
                    const y = Math.min(h - 1, by * 4 + (i >> 2));
                    const q = (y * w + x) * 4;
                    rgb[i * 3] = rgba[q]; rgb[i * 3 + 1] = rgba[q + 1]; rgb[i * 3 + 2] = rgba[q + 2];
                    a[i] = rgba[q + 3];
                }
                const o = (by * bw + bx) * 16;
                encodeAlphaBlock(a, out, o);
                encodeColorBlock(rgb, a, out, o + 8);
            }
        }
        return out;
    }

    /** ย่อ rgba ครึ่งหนึ่ง (เฉลี่ย 2x2 ถ่วงด้วย alpha ไม่ให้ขอบใสดึงสีให้คล้ำ) */
    function halveRGBA(px, w, h) {
        const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
        const out = new Uint8Array(nw * nh * 4);
        for (let y = 0; y < nh; y++) {
            for (let x = 0; x < nw; x++) {
                let sa = 0, sr = 0, sg = 0, sb = 0;
                for (const [xx, yy] of [[x * 2, y * 2], [x * 2 + 1, y * 2], [x * 2, y * 2 + 1], [x * 2 + 1, y * 2 + 1]]) {
                    const q = (Math.min(h - 1, yy) * w + Math.min(w - 1, xx)) * 4;
                    const al = px[q + 3];
                    sa += al; sr += px[q] * al; sg += px[q + 1] * al; sb += px[q + 2] * al;
                }
                const o = (y * nw + x) * 4;
                out[o + 3] = (sa + 2) >> 2;
                if (sa) { out[o] = Math.round(sr / sa); out[o + 1] = Math.round(sg / sa); out[o + 2] = Math.round(sb / sa); }
            }
        }
        return out;
    }

    /** rgba size x size → ข้อมูล BC3 สีจริงครบทุกชั้น (เรียงต่อกัน + จองที่ตามเกม) */
    function buildAlbedoMipsRGBA(rgba, size, mips) {
        const parts = [];
        let px = rgba, w = size, h = size, total = 0;
        for (let m = 0; m < mips; m++) {
            const enc = encodeBC3RGBA(px, w, h);
            const slot = mipBytes(w, h, 16);
            const padded = new Uint8Array(slot);
            padded.set(enc.subarray(0, Math.min(enc.length, slot)));
            parts.push(padded);
            total += slot;
            if (m < mips - 1) { px = halveRGBA(px, w, h); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
        }
        const out = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    /** ย่อ alpha ครึ่งหนึ่ง (เฉลี่ย 2x2) */
    function halve(alpha, w, h) {
        const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
        const out = new Uint8Array(nw * nh);
        for (let y = 0; y < nh; y++) {
            for (let x = 0; x < nw; x++) {
                const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
                const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
                out[y * nw + x] = (alpha[y0 * w + x0] + alpha[y0 * w + x1] + alpha[y1 * w + x0] + alpha[y1 * w + x1] + 2) >> 2;
            }
        }
        return out;
    }

    /** ขนาดข้อมูลของ mip หนึ่งชั้นในไฟล์ (เกมจองขั้นต่ำ 64 บล็อกต่อชั้น) */
    function mipBytes(w, h, blockSize) {
        const blocks = Math.max(1, w >> 2) * Math.max(1, h >> 2);
        return Math.max(blocks, 64) * blockSize;
    }

    /** alpha 512x512 → ข้อมูล BC3 ครบ 10 ชั้น (เรียงต่อกัน + จองที่ตามเกม) */
    function buildAlbedoMips(alpha, size, mips) {
        const parts = [];
        let a = alpha, w = size, h = size, total = 0;
        for (let m = 0; m < mips; m++) {
            const enc = encodeBC3(a, w, h);
            const slot = mipBytes(w, h, 16);
            const padded = new Uint8Array(slot);
            padded.set(enc.subarray(0, Math.min(enc.length, slot)));
            parts.push(padded);
            total += slot;
            if (m < mips - 1) { a = halve(a, w, h); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
        }
        const out = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    // ───────────────────────────────────────────── ไฟล์ RSC8 ──────────

    function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }

    /**
     * ประกอบ .ytd (ยังไม่บีบอัด)
     * @param name    ชื่อไฟล์ไม่รวม .ytd — texture ข้างในจะชื่อ <name>_ab / <name>_ma
     * @param abData  BC3 10 mips (จาก buildAlbedoMips)
     * @param maData  material ต้นแบบ (ปกติ BC1 8 mips ของ coyote)
     * @param maInfo  รูปแบบของ maData ถ้าไม่ใช่ BC1 8 mips — { fmt, bsz, mips }
     * @param abInfo  รูปแบบของ abData ถ้าไม่ใช่ BC3 512x512 10 mips — { fmt, bsz, mips, w, h }
     * @returns {{ header: Uint8Array, body: Uint8Array }}  body = virtual + physical ก่อนบีบอัด
     */
    function buildYtd(name, abData, maData, maInfo, abInfo) {
        const ab = Object.assign({ fmt: FMT_BC3, bsz: 16, mips: 10, w: 512, h: 512 }, abInfo || {});
        const ma = Object.assign({ fmt: FMT_BC1, bsz: 8, mips: 8, w: 512, h: 512 }, maInfo || {});
        const textures = [
            { name: name + '_ab', fmt: ab.fmt, bsz: ab.bsz, mips: ab.mips, w: ab.w, h: ab.h, data: abData },
            { name: name + '_ma', fmt: ma.fmt, bsz: ma.bsz, mips: ma.mips, w: ma.w, h: ma.h, data: maData },
        ];
        textures.forEach((t) => { t.hash = joaat(t.name); });

        // ช่องเก็บ texture เรียงตาม hash (เกมค้นแบบ binary search)
        const slots = textures.slice().sort((a, b) => a.hash - b.hash);

        // physical: หน้าใหญ่ก่อน (หน้า = กำลังสองที่พอดีกับข้อมูล) ขนาดเท่ากันเรียงตามช่อง (hash)
        const phys = slots.slice().sort((a, b) => nextPow2(b.data.length) - nextPow2(a.data.length));
        let physSize = 0;
        for (const t of phys) { t.physOff = physSize; physSize += nextPow2(t.data.length); }

        const body = new Uint8Array(VIRTUAL_SIZE + physSize);
        const dv = new DataView(body.buffer);
        // pointer 64 บิตในไฟล์: 0x5xxxxxxx = ส่วน virtual, 0x6xxxxxxx = ส่วน physical
        const setPtr = (at, segment, off) => {
            dv.setUint32(at, (segment === 5 ? 0x50000000 : 0x60000000) + off, true);
            dv.setUint32(at + 4, 0, true);
        };

        const TEX0 = 0x1060, INNER0 = 0x1140, NAMES = 0x11c0;

        // ชื่อ texture ต่อกันตามลำดับช่อง
        let n = NAMES;
        slots.forEach((t) => {
            t.nameOff = n;
            for (let i = 0; i < t.name.length; i++) body[n++] = t.name.charCodeAt(i);
            body[n++] = 0;
        });
        const TEXARR = (n + 15) & ~15;
        const HASHARR = TEXARR + 8 * slots.length;
        if (HASHARR + 4 * slots.length > VIRTUAL_SIZE) throw new Error('ชื่อยาวเกินไป');

        // dictionary
        setPtr(0x08, 5, 0x40);
        dv.setUint32(0x18, 1, true);
        setPtr(0x20, 5, HASHARR);
        dv.setUint16(0x28, slots.length, true); dv.setUint16(0x2a, slots.length, true);
        setPtr(0x30, 5, TEXARR);
        dv.setUint16(0x38, slots.length, true); dv.setUint16(0x3a, slots.length, true);
        body[0x48] = 1; body[0x49] = 1;          // page map: 1 virtual / 1 physical

        slots.forEach((t, i) => {
            const T = TEX0 + i * 0x70, I = INNER0 + i * 0x40;
            dv.setUint32(T + 0x08, t.data.length / t.bsz, true);
            dv.setUint32(T + 0x0c, t.bsz, true);
            body.set([0x02, 0x80, 0x00, 0x18], T + 0x10);
            dv.setUint16(T + 0x18, t.w, true); dv.setUint16(T + 0x1a, t.h, true);
            body.set([0x01, 0x00, 0x01, t.fmt], T + 0x1c);
            body.set([0x0d, 0x00, t.mips, 0x00, 0x00, 0x00, 0x01, 0x00], T + 0x20);
            setPtr(T + 0x28, 5, t.nameOff);
            setPtr(T + 0x30, 5, I);
            setPtr(T + 0x38, 6, t.physOff);
            body.set([0x01, 0x04], I + 0x10);
            body[I + 0x18] = 0x05;

            setPtr(TEXARR + i * 8, 5, T);
            dv.setUint32(HASHARR + i * 4, t.hash, true);
            body.set(t.data, VIRTUAL_SIZE + t.physOff);
        });

        const header = new Uint8Array(16);
        const hv = new DataView(header.buffer);
        header.set([0x52, 0x53, 0x43, 0x38]);   // RSC8
        hv.setUint32(4, 2, true);
        hv.setUint32(8, VIRTUAL_SIZE, true);
        hv.setUint32(12, physSize, true);
        return { header, body };
    }

    // ───────────────────────────────────────────── อ่าน .ytd ─────────
    // โครงตาม CodeX (CodeX.Games.RDR2/RSC8/Rsc8Texture.cs):
    //   header 16 byte: 'RSC8', version, virtual flags (ขนาด = flags & ~0xF), physical flags · ที่เหลือ deflate-raw
    //   pointer 0x5xxxxxxx = ส่วน virtual · 0x6xxxxxxx = ส่วน physical (ต่อท้าย virtual)
    //   dictionary: +0x30 = ptr รายการ texture, +0x38 = จำนวน
    //   texture: +0x18 w, +0x1A h, +0x1F format (เลขเดียวกับ DXGI), +0x22 mips, +0x28 ชื่อ, +0x38 ข้อมูล
    //   ข้อมูล = mip เรียงต่อกันขนาดพอดี (ไม่มี padding) — ใช้แค่ mip แรก

    const FORMATS = {
        70: 'bc1', 71: 'bc1', 72: 'bc1', 73: 'bc2', 74: 'bc2', 75: 'bc2', 76: 'bc3', 77: 'bc3', 78: 'bc3',
        79: 'bc4', 80: 'bc4', 82: 'bc5', 83: 'bc5',
        27: 'rgba', 28: 'rgba', 29: 'rgba', 87: 'bgra', 88: 'bgrx', 90: 'bgra', 91: 'bgra',
        61: 'r8', 65: 'a8',
    };
    const FORMAT_NAME = { 94: 'BC6H', 95: 'BC6H', 96: 'BC6H', 97: 'BC7', 98: 'BC7', 99: 'BC7' };

    /** หัวไฟล์ RSC8 → { virtualSize } หรือ throw */
    function readYtdHeader(bytes) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length < 16 || dv.getUint32(0, true) !== 0x38435352) throw new Error('ไม่ใช่ไฟล์ .ytd ของ RDR2 (ไม่มีหัว RSC8)');
        return { version: dv.getUint32(4, true), virtualSize: dv.getUint32(8, true) & ~0xF };
    }

    /** รายการ texture ใน .ytd ที่แตกแล้ว (body = ข้อมูลหลัง header 16 byte ที่ inflate แล้ว) */
    function parseYtd(body, virtualSize) {
        const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const at = (ptr) => {
            const seg = ptr >>> 28, off = ptr & 0x0fffffff;
            const o = seg === 5 ? off : seg === 6 ? virtualSize + off : -1;
            if (o < 0 || o >= body.length) throw new Error('pointer ในไฟล์ผิดรูปแบบ (ไฟล์เสียหรือไม่ใช่ texture dictionary)');
            return o;
        };
        const list = at(dv.getUint32(0x30, true)), count = dv.getUint16(0x38, true);
        const out = [];
        for (let i = 0; i < count; i++) {
            const t = at(dv.getUint32(list + i * 8, true));
            let name = '';
            for (let k = at(dv.getUint32(t + 0x28, true)); k < body.length && body[k]; k++) name += String.fromCharCode(body[k]);
            out.push({
                name,
                w: dv.getUint16(t + 0x18, true),
                h: dv.getUint16(t + 0x1a, true),
                format: body[t + 0x1f],
                mips: body[t + 0x22],
                dataAt: at(dv.getUint32(t + 0x38, true)),
            });
        }
        return out;
    }

    /** mip แรกของ texture → RGBA (Uint8ClampedArray w*h*4) */
    function decodeTexture(body, tex) {
        const fmt = FORMATS[tex.format];
        if (!fmt) {
            throw new Error(`texture ${tex.name} เป็นแบบ ${FORMAT_NAME[tex.format] || 'format ' + tex.format} ยังเปิดไม่ได้ ` +
                '(ได้ BC1-BC5 / RGBA) — export จาก CodeX เป็น DDS/PNG แล้วเพิ่มเป็นรูปแทน');
        }
        const { w, h } = tex, u8 = body, start = tex.dataAt;
        const out = new Uint8ClampedArray(w * h * 4);
        if (fmt === 'rgba' || fmt === 'bgra' || fmt === 'bgrx' || fmt === 'r8' || fmt === 'a8') {
            const px = fmt === 'r8' || fmt === 'a8' ? 1 : 4;
            if (start + w * h * px > u8.length) throw new Error(`ข้อมูล ${tex.name} ไม่ครบ`);
            for (let i = 0; i < w * h; i++) {
                const s = start + i * px, d = i * 4;
                if (fmt === 'r8') { out[d] = out[d + 1] = out[d + 2] = u8[s]; out[d + 3] = 255; }
                else if (fmt === 'a8') { out[d + 3] = u8[s]; }
                else if (fmt === 'rgba') { out[d] = u8[s]; out[d + 1] = u8[s + 1]; out[d + 2] = u8[s + 2]; out[d + 3] = u8[s + 3]; }
                else { out[d] = u8[s + 2]; out[d + 1] = u8[s + 1]; out[d + 2] = u8[s]; out[d + 3] = fmt === 'bgrx' ? 255 : u8[s + 3]; }
            }
            return out;
        }

        const size = fmt === 'bc1' || fmt === 'bc4' ? 8 : 16;
        const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
        if (start + bw * bh * size > u8.length) throw new Error(`ข้อมูล ${tex.name} ไม่ครบ`);
        const pal = new Uint8Array(16), a = new Uint8Array(16), c2 = new Uint8Array(16);

        // บล็อกค่าเดียว 8 byte (alpha ของ BC3 / ช่องของ BC4 BC5) → 16 ค่า
        const single = (o, dst) => {
            const a0 = u8[o], a1 = u8[o + 1], t = [a0, a1];
            if (a0 > a1) for (let k = 1; k < 7; k++) t.push(((7 - k) * a0 + k * a1) / 7 | 0);
            else { for (let k = 1; k < 5; k++) t.push(((5 - k) * a0 + k * a1) / 5 | 0); t.push(0, 255); }
            for (let half = 0; half < 2; half++) {
                const q = o + 2 + half * 3, bits = u8[q] | (u8[q + 1] << 8) | (u8[q + 2] << 16);
                for (let i = 0; i < 8; i++) dst[half * 8 + i] = t[(bits >> (3 * i)) & 7];
            }
        };
        const c565 = (v, k) => {
            pal[k * 4] = ((v >> 11) & 31) * 255 / 31;
            pal[k * 4 + 1] = ((v >> 5) & 63) * 255 / 63;
            pal[k * 4 + 2] = (v & 31) * 255 / 31;
            pal[k * 4 + 3] = 255;
        };

        for (let by = 0; by < bh; by++) {
            for (let bx = 0; bx < bw; bx++) {
                let o = start + (by * bw + bx) * size;
                a.fill(255);
                if (fmt === 'bc4' || fmt === 'bc5') {
                    single(o, a);                               // R
                    if (fmt === 'bc5') single(o + 8, c2);       // G
                    for (let i = 0; i < 16; i++) {
                        const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
                        if (x >= w || y >= h) continue;
                        const d = (y * w + x) * 4;
                        out[d] = a[i]; out[d + 1] = fmt === 'bc5' ? c2[i] : a[i]; out[d + 2] = fmt === 'bc5' ? 0 : a[i]; out[d + 3] = 255;
                    }
                    continue;
                }
                if (fmt === 'bc2') {
                    for (let i = 0; i < 16; i++) a[i] = ((u8[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
                    o += 8;
                } else if (fmt === 'bc3') {
                    single(o, a);
                    o += 8;
                }
                const c0 = u8[o] | (u8[o + 1] << 8), c1 = u8[o + 2] | (u8[o + 3] << 8);
                const bits = (u8[o + 4] | (u8[o + 5] << 8) | (u8[o + 6] << 16) | (u8[o + 7] << 24)) >>> 0;
                c565(c0, 0);
                c565(c1, 1);
                if (fmt !== 'bc1' || c0 > c1) {
                    for (let c = 0; c < 3; c++) {
                        pal[8 + c] = (2 * pal[c] + pal[4 + c]) / 3;
                        pal[12 + c] = (pal[c] + 2 * pal[4 + c]) / 3;
                    }
                    pal[11] = pal[15] = 255;
                } else {
                    for (let c = 0; c < 3; c++) { pal[8 + c] = (pal[c] + pal[4 + c]) / 2; pal[12 + c] = 0; }
                    pal[11] = 255;
                    pal[15] = 0;                                // BC1 โหมด 3 สี: ช่อง 3 = โปร่งใส
                }
                for (let i = 0; i < 16; i++) {
                    const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
                    if (x >= w || y >= h) continue;
                    const k = (bits >> (2 * i)) & 3, d = (y * w + x) * 4;
                    out[d] = pal[k * 4]; out[d + 1] = pal[k * 4 + 1]; out[d + 2] = pal[k * 4 + 2];
                    out[d + 3] = fmt === 'bc1' ? pal[k * 4 + 3] : a[i];
                }
            }
        }
        return out;
    }

    // ───────────────────────────────────────────── แขนสลับ (_sw) ─────
    // โมเดลท่อนบนตอนใส่เสื้อ / ถุงมือ (mp_uppertorso_*r1_000_full, _g, _vest ...) วางเกาะ UV ของแขนซ้าย-ขวา
    // สลับกับตัวเปล่า (mp_uppertorso_*r1_000) — ครึ่งบนของภาพ (v < 0.5 = แขน) เลื่อน u ไปครึ่งภาพ ลำตัวเหมือนเดิม
    // (ตรวจกับโมเดลที่ export จาก CodeX ทุกแบบ: กฎนี้ตรง 100% เว้นวงข้อมือของแบบถุงมือตัดนิ้ว)
    // → ไฟล์ <ชื่อ>_sw = ลายเดียวกันที่สลับซ้าย-ขวาเฉพาะครึ่งบน ทำที่ระดับบล็อก BC (ไม่เข้ารหัสใหม่ ไม่เสียคุณภาพ)

    /** สลับครึ่งซ้าย-ขวาของครึ่งบนภาพ ทุก mip (data = mip ต่อกันแบบใน .ytd) — คืนข้อมูลใหม่ */
    function swapArmHalves(data, w, h, mips, bsz) {
        const out = new Uint8Array(data);
        let off = 0;
        for (let m = 0; m < mips; m++) {
            const bw = Math.max(1, ((w >> m) + 3) >> 2), bh = Math.max(1, ((h >> m) + 3) >> 2);
            // mip เล็กจนครึ่งไม่ลงบล็อก (กว้าง/สูง < 8 จุด) ข้ามไป — เล็กเกินกว่าจะเห็น
            if (bw >= 2 && bh >= 2 && bw % 2 === 0 && bh % 2 === 0) {
                const half = bw / 2, row = bw * bsz;
                for (let by = 0; by < bh / 2; by++) {
                    const r = off + by * row;
                    const left = data.slice(r, r + half * bsz);
                    out.set(data.subarray(r + half * bsz, r + row), r);
                    out.set(left, r + half * bsz);
                }
            }
            off += bw * bh * bsz;
        }
        return out;
    }

    /** .ytd (แตกแล้ว) → .ytd ของลายแขนสลับ ชื่อ <name>_sw (texture ข้างใน <name>_sw_ab / _sw_ma) */
    function buildSwappedYtd(body, virtualSize, name) {
        const all = parseYtd(body, virtualSize);
        const pick = (re) => all.find((t) => re.test(t.name));
        const ab = pick(/_ab$/i), ma = pick(/_ma$/i);
        if (!ab || !ma) throw new Error(name + ': ต้องมี texture _ab และ _ma');
        const info = (t) => {
            const bsz = t.format === FMT_BC1 || t.format === 72 ? 8 : 16;
            let size = 0;
            for (let m = 0; m < t.mips; m++) size += Math.max(1, ((t.w >> m) + 3) >> 2) * Math.max(1, ((t.h >> m) + 3) >> 2) * bsz;
            return { fmt: t.format, bsz, mips: t.mips, w: t.w, h: t.h, data: body.subarray(t.dataAt, t.dataAt + size) };
        };
        const A = info(ab), M = info(ma);
        const abData = swapArmHalves(A.data, A.w, A.h, A.mips, A.bsz);
        return buildYtd(name + '_sw', abData, M.data,
            { fmt: M.fmt, bsz: M.bsz, mips: M.mips, w: M.w, h: M.h },
            { fmt: A.fmt, bsz: A.bsz, mips: A.mips, w: A.w, h: A.h });
    }

    const api = {
        joaat, encodeBC3, encodeBC3RGBA, buildAlbedoMips, buildAlbedoMipsRGBA, buildYtd, mipBytes,
        readYtdHeader, parseYtd, decodeTexture, swapArmHalves, buildSwappedYtd,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TattooYtd = api;
})(typeof self !== 'undefined' ? self : this);
