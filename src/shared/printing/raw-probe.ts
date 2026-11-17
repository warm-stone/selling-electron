/**
 * RAW 编码探针（F1）——共享层：段标签与判读指引。
 *
 * 为什么需要探针：spooler 通道走 `winspool.WritePrinter(pDataType='RAW')`，字节
 * **完全绕开打印机驱动**，由固件自己解释。所以「Word 里能打中文」证明不了 RAW
 * 能打中文——Word 走 GDI → 驱动光栅化，那正是 driver 通道。真机（得力 DL-5801PW）
 * 的表现是「英文可打、中文与 Logo 不出」，指向固件按纯文本渲染而非 ESC/POS。
 *
 * 探针把四种编码假设排在同一张纸上一次打完，纸上结果直接决定 spooler 通道的修法，
 * 不必逐次改代码重试。段标签是纸上真正打印的 ASCII 文字（照纸找段），主进程 builder
 * 与渲染层判读表共用这一份常量——标签改了判读表不会失配。
 */

/** 纸上四段的 ASCII 标题行（探针页与判读表共用同一字符串） */
export const RAW_PROBE_SEGMENT_LABELS = {
  ascii: '[S1] ASCII baseline',
  utf8: '[S2] UTF-8 raw bytes',
  gbk: '[S3] GBK + FS& (app path)',
  raster: '[S4] RASTER GS v 0'
} as const

export type RawProbeSegmentId = keyof typeof RAW_PROBE_SEGMENT_LABELS

export interface RawProbeReading {
  id: RawProbeSegmentId
  /** 纸上这一段应当出现什么 */
  prints: string
  /** 这一段实际发出的字节（与 builder 同源描述） */
  bytes: string
  /** 正常出字/出图说明什么，对应哪种修法 */
  ifWorks: string
  /** 空白或乱码说明什么 */
  ifFails: string
}

export const RAW_PROBE_READINGS: readonly RawProbeReading[] = [
  {
    id: 'ascii',
    prints: '一条与列宽等长的数字尺 + 一行英文',
    bytes: 'ESC @ 之后直发 ASCII + LF，不含任何编码切换指令',
    ifWorks:
      'RAW 通道通、走纸正常，探针页确实到了打印机——这是 S2/S3/S4 的判读前提。数字尺还能读出该机 RAW 通道的实际可打列数（尺子被截断的位置就是右边界）',
    ifFails:
      '连英文都没有 → 不是编码问题：通道/端口/打印机名/驱动的 RAW 支持有问题，回诊断报告看 R1–R8'
  },
  {
    id: 'utf8',
    prints: '一行中文「中文测试 你好 A1」',
    bytes: '同一句话的 UTF-8 原始字节（汉字 3 字节），不进汉字模式',
    ifWorks:
      '固件按 UTF-8 解释文本（云固件常见）→ 修法是给 spooler 通道加「RAW 文本模式(UTF-8)」开关（F2），改完系统打印就能出中文',
    ifFails:
      '固件不吃 UTF-8。若打出「涓枃娴嬭瘯」这类汉字乱码 = 固件把 UTF-8 字节按 GBK 双字节配对了；若整段空白 = 高位字节被丢弃'
  },
  {
    id: 'gbk',
    prints: '与 S2 逐字相同的一行中文',
    bytes:
      'ESC R 15 + FS &（1c 26）进汉字模式 + GB2312/GBK 双字节 + FS .（1c 2e）退出——与应用当前 spooler 打印链逐字节同源',
    ifWorks:
      '标准 ESC/POS 中文可用，说明现有链路本该正常 → 中文不出的原因不在编码，把探针页照片与诊断报告一起给我继续查',
    ifFails:
      '固件不支持 GBK 汉字模式（与真机现象一致）→ 应用现有 spooler 中文链路在这台机器上无解，只能走 S2 或 S4'
  },
  {
    id: 'raster',
    prints: '一个约 12mm×4mm 的实心黑块',
    bytes:
      'GS v 0（1d 76 30）光栅位图，m=0x00 规范值、宽度按 8 点对齐——与 Logo 打印同一条 buildLogoRaster 路径',
    ifWorks:
      '固件支持 ESC/POS 光栅 → 终极修法：把整张小票（含中文）在应用侧光栅化成位图再走 GS v 0，与打印机字体/编码完全无关，一定能打出来',
    ifFails:
      '固件不支持光栅位图 → RAW 通道只能打 ASCII，spooler 通道无法支持中文与 Logo，必须留在 driver（驱动渲染）通道'
  }
]

/** 结论速查：纸上组合 → spooler 通道能不能修、怎么修 */
export const RAW_PROBE_VERDICTS: readonly { when: string; then: string }[] = [
  { when: '只有 S1 出字', then: 'RAW 通道只能打 ASCII：系统打印通道无法支持中文，保持 driver 通道（当前兜底），不必再试' },
  { when: 'S1 + S2 出字', then: '固件要 UTF-8：给 spooler 通道加「RAW 文本模式(UTF-8)」开关，改完即可用系统打印' },
  { when: 'S1 + S3 出字', then: '标准 ESC/POS 中文可用：问题不在编码，带探针页照片 + 诊断报告继续查处理器/端口' },
  { when: 'S1 + S4 出黑块', then: '光栅可用：整页光栅化走 GS v 0，中文与 Logo 一并解决' },
  {
    when: '多段同时可用',
    then: '优先级 S4 光栅 > S3 GBK > S2 UTF-8：光栅与打印机字体、编码完全解耦，最不容易随固件升级回退'
  }
]
