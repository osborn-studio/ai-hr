// ============================================================================
// app/zip.mjs · 写 zip（零依赖，只用 node:zlib）
// ----------------------------------------------------------------------------
// 为什么自己写、而不引一个包（`archiver` / `jszip`）：
// 这个仓库的依赖只有 PGlite 与 pg（见 xlsx.mjs 开头那段自述）。多一个"打包"
// 的依赖，就多一条供应链、多一份 CVE 订阅、多一次"它升级了我们不敢升"。
// 而 zip 的**写**这一侧，格式比读还简单 —— 没有 deflate 编码器要自己写，
// zlib 已经给了 `deflateRawSync`；剩下的只是把三段结构按顺序摆好：
//
//   ① 本地文件头 + 文件数据（每个文件一组，紧挨着）
//        0x04034b50 | 版本 | 标志 | 方式 | 时间 | 日期 | CRC | 压缩后大小 | 原始大小 | 名字长 | 额外长
//   ② 中央目录（每个文件一条，指向 ① 里的偏移）
//        0x02014b50 | 造它的版本 | 需要的版本 | 标志 | 方式 | 时间 | 日期 | CRC |
//        压缩后大小 | 原始大小 | 名字长 | 额外长 | 注释长 | 磁盘号 | 内部属性 |
//        外部属性 | 本地头偏移
//   ③ EOCD（目录结束记录，唯一能"从尾巴找到整个包"的东西）
//        0x06054b50 | 磁盘号 | 目录所在磁盘 | 本盘条目数 | 总条目数 | 目录大小 | 目录偏移 | 注释长
//
// ★ 三个最容易写错的点，都在下面用断言/注释钉住了：
//   ① **CRC32 是原始数据的，不是压缩后数据的**。写反了，Windows 资源管理器
//      解出来是"文件已损坏"，而 macOS 的 unzip / 我们的读侧**都不报错**
//      （它们不校验 CRC）—— 于是这个错会一路发到财务的 Windows 电脑上才暴露。
//   ② **偏移量指的是本地文件头的起点**，不是数据的起点。
//   ③ **文件名必须是 UTF-8 且置 0x0800 标志位**，否则中文门店名在 Windows 上
//      变成乱码（zip 的默认编码是 CP437）。这条对"文件名要一眼看出是哪个门店"
//      是致命的：乱码的文件名等于没有文件名。
//
// ★ 不支持 zip64（>4GB / >65535 个文件）：工资单打包远到不了那个量级，
//   而写了 zip64 就等于写了一段**永远不会被执行**的分支 —— 那是最难维护的代码。
//   真越界时抛一个说人话的错，而不是产出一个坏包。
// ============================================================================
import { deflateRawSync } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;      // 文件名按 UTF-8 解释（见文件头 ③）
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION = 20;            // 2.0：deflate 与目录结构的最低版本

// ---------------------------------------------------------------------------
// CRC32（IEEE 802.3，zip 用的那个）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * 一段字节的 CRC32。
 * @param {Buffer} buf
 * @returns {number} 无符号 32 位
 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// MS-DOS 时间格式（zip 里没有 Unix 时间戳：1980 起、2 秒粒度）
// ---------------------------------------------------------------------------
function dosDateTime(d) {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/**
 * 打一个 zip。
 *
 * @param {Array<{name: string, data: Buffer|string, compress?: boolean}>} entries
 *   条目按给定顺序写入（顺序即解压后看到顺序，人读得出来）
 * @param {{level?: number, now?: Date}} [opts]  level 是 zlib 的压缩级别（默认 6）
 * @returns {Buffer}
 */
export function makeZip(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const level = Number.isInteger(opts.level) ? opts.level : 6;
  const { date, time } = dosDateTime(opts.now instanceof Date ? opts.now : new Date());

  if (list.length > 0xffff) {
    throw new Error(`E_ZIP_TOO_MANY: ${list.length} 个文件超过 zip 上限 65535（本仓不写 zip64）`);
  }
  const seen = new Set();
  for (const e of list) {
    const name = String(e?.name ?? '');
    if (!name) throw new Error('E_ZIP_NAME: 条目缺少文件名');
    if (name.startsWith('/') || name.includes('\\')) {
      throw new Error(`E_ZIP_NAME: 条目名 ${name} 必须是相对的、正斜杠分隔的路径`);
    }
    if (seen.has(name)) throw new Error(`E_ZIP_NAME: 条目名重复 ${name}`);
    seen.add(name);
  }

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of list) {
    const name = String(e.name);
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    // ★ CRC 算的是**原始**数据（见文件头 ①）
    const crc = crc32(raw);

    // 压一下再看值不值得压：小文件（几十字节）压完反而更大，
    // 那时用 store（方式 0）—— 包里两种方式并存是合法的。
    let method = METHOD_STORE;
    let body = raw;
    if (e.compress !== false && raw.length > 0) {
      const deflated = deflateRawSync(raw, { level });
      if (deflated.length < raw.length) {
        method = METHOD_DEFLATE;
        body = deflated;
      }
    }

    // ---- ① 本地文件头 ----
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // 本地额外字段：不用（数据描述的 0x5455 可选）

    locals.push(local, nameBuf, body);

    // ---- ② 中央目录条目：偏移指向**本地头的起点**（见文件头 ②） ----
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION, 4);      // 造它的版本（这里与所需版本相同，够用）
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);           // 额外字段长
    central.writeUInt16LE(0, 32);           // 注释长
    central.writeUInt16LE(0, 34);           // 起始磁盘号
    central.writeUInt16LE(0, 36);           // 内部属性
    central.writeUInt32LE(0, 38);           // 外部属性（权限位；打包件不需要）
    central.writeUInt32LE(offset, 42);      // ★ 本地头偏移
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  if (offset > 0xffffffff || centralPart.length > 0xffffffff) {
    throw new Error('E_ZIP_TOO_LARGE: 包体超过 4GB（本仓不写 zip64）');
  }

  // ---- ③ EOCD ----
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);                 // 本磁盘号
  eocd.writeUInt16LE(0, 6);                 // 目录所在磁盘号
  eocd.writeUInt16LE(list.length, 8);       // 本磁盘条目数
  eocd.writeUInt16LE(list.length, 10);      // 总条目数
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16); // 目录的偏移 = 本地部分的总长
  eocd.writeUInt16LE(0, 20);                // 注释长

  return Buffer.concat([localPart, centralPart, eocd]);
}
