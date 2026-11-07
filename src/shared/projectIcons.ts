// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F01 project icon — the frozen ProjectIconPicker emoji catalogue and
// its search port. The frozen pickers second half, SF Symbols, is an
// Apple-proprietary mark set that cannot render or ship on Windows;
// this build stores and offers emoji marks only, with the Folder
// tile clearing back to the default mark.

export interface EmojiEntry {
  emoji: string;
  keywords: string;
}

export interface EmojiGroup {
  id: string;
  /** i18n key — the frozen English title is the lookup key. */
  title: string;
  /** zh keywords folded into the search match like the frozen list. */
  keywords: string;
  entries: EmojiEntry[];
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  { id: "development-tools", title: "Development & Tools", keywords: "开发与工具", entries: [{"emoji": "🛠️", "keywords": "tools hammer wrench repair 工具 锤子 扳手 维修"},{"emoji": "📦", "keywords": "package box delivery 包裹 箱子 快递"},{"emoji": "🧩", "keywords": "puzzle piece plugin 拼图 插件"},{"emoji": "⚙️", "keywords": "gear settings configuration 齿轮 设置 配置"},{"emoji": "🏗️", "keywords": "construction crane building 施工 起重机 建造"},{"emoji": "🔧", "keywords": "wrench repair maintenance 扳手 维修 维护"},{"emoji": "🧰", "keywords": "toolbox toolkit 工具箱 工具包"},{"emoji": "🧱", "keywords": "brick wall building 砖 墙 建筑"},{"emoji": "🗝️", "keywords": "key unlock access 钥匙 解锁 访问"},{"emoji": "🔐", "keywords": "lock key security privacy 锁 钥匙 安全 隐私"},{"emoji": "🛡️", "keywords": "shield protection security 盾牌 防护 安全"},{"emoji": "🤖", "keywords": "robot bot ai automation 机器人 人工智能 自动化"}] },
  { id: "devices-technology", title: "Devices & Technology", keywords: "设备与科技", entries: [{"emoji": "🔋", "keywords": "battery power charge 电池 电量 充电"},{"emoji": "🔌", "keywords": "plug electricity power 插头 电源 电力"},{"emoji": "📡", "keywords": "satellite antenna signal 卫星 天线 信号"},{"emoji": "🎛️", "keywords": "control knobs mixer 控制 旋钮 调音台"},{"emoji": "🖲️", "keywords": "trackball input 轨迹球 输入"},{"emoji": "🖨️", "keywords": "printer print 打印机 打印"},{"emoji": "⌨️", "keywords": "keyboard typing 键盘 打字"},{"emoji": "🖥️", "keywords": "desktop computer monitor 台式电脑 显示器"},{"emoji": "💻", "keywords": "laptop computer notebook 笔记本 电脑"},{"emoji": "🖱️", "keywords": "mouse click cursor 鼠标 点击 光标"},{"emoji": "📱", "keywords": "phone mobile smartphone 手机 移动 智能手机"},{"emoji": "⌚️", "keywords": "watch time wearable 手表 时间 穿戴"},{"emoji": "🎧", "keywords": "headphones audio music 耳机 音频 音乐"},{"emoji": "🔊", "keywords": "speaker volume sound 扬声器 音量 声音"},{"emoji": "🎤", "keywords": "microphone singing recording 麦克风 唱歌 录音"},{"emoji": "📷", "keywords": "camera photo photography 相机 照片 摄影"},{"emoji": "🎥", "keywords": "movie camera video filming 摄像机 视频 拍摄"}] },
  { id: "work-creativity", title: "Work & Creativity", keywords: "工作与创作", entries: [{"emoji": "🎨", "keywords": "art palette paint design 艺术 调色盘 绘画 设计"},{"emoji": "📊", "keywords": "chart data analytics 图表 数据 分析"},{"emoji": "📚", "keywords": "books reading library 书籍 阅读 图书馆"},{"emoji": "🧵", "keywords": "thread sewing craft 线 缝纫 手工"},{"emoji": "🏺", "keywords": "amphora pottery vase 陶罐 陶艺 花瓶"},{"emoji": "🖼️", "keywords": "picture frame art gallery 图片 相框 艺术 画廊"},{"emoji": "🖌️", "keywords": "paintbrush painting 画笔 绘画"},{"emoji": "🖍️", "keywords": "crayon drawing 蜡笔 画画"},{"emoji": "✏️", "keywords": "pencil writing sketch 铅笔 写作 草图"},{"emoji": "📝", "keywords": "memo note writing 备忘 笔记 写作"},{"emoji": "📌", "keywords": "pushpin pin reminder 图钉 固定 提醒"},{"emoji": "📍", "keywords": "pin location place 定位 位置 地点"},{"emoji": "📎", "keywords": "paperclip attachment 回形针 附件"},{"emoji": "🗂️", "keywords": "index dividers organize 分类 索引 整理"},{"emoji": "🗃️", "keywords": "card file box archive 卡片 文件盒 档案"},{"emoji": "🗄️", "keywords": "filing cabinet storage 文件柜 存储"},{"emoji": "📁", "keywords": "folder directory files 文件夹 目录 文件"},{"emoji": "📂", "keywords": "open folder directory 打开 文件夹 目录"},{"emoji": "🗓️", "keywords": "spiral calendar schedule 日历 日程 排期"},{"emoji": "📅", "keywords": "calendar date event 日历 日期 活动"},{"emoji": "🧮", "keywords": "abacus calculation accounting 算盘 计算 会计"},{"emoji": "🎓", "keywords": "graduation education learning 毕业 教育 学习"},{"emoji": "🧑‍🏫", "keywords": "teacher teaching education 老师 教学 教育"},{"emoji": "💼", "keywords": "briefcase business work 公文包 商务 工作"}] },
  { id: "science-exploration", title: "Science & Exploration", keywords: "科学与探索", entries: [{"emoji": "🚀", "keywords": "rocket launch space 火箭 发射 太空"},{"emoji": "🧪", "keywords": "test tube chemistry experiment 试管 化学 实验"},{"emoji": "🧠", "keywords": "brain mind intelligence 大脑 思维 智力"},{"emoji": "🛰️", "keywords": "satellite orbit space 卫星 轨道 太空"},{"emoji": "🧭", "keywords": "compass navigation direction 指南针 导航 方向"},{"emoji": "🧲", "keywords": "magnet magnetism physics 磁铁 磁力 物理"},{"emoji": "💡", "keywords": "bulb light idea 灯泡 灯光 灵感"},{"emoji": "🔍", "keywords": "magnifying glass search inspect 放大镜 搜索 检查"},{"emoji": "🔎", "keywords": "magnifying glass search discover 放大镜 搜索 发现"},{"emoji": "🔭", "keywords": "telescope astronomy observation 望远镜 天文 观测"},{"emoji": "🔬", "keywords": "microscope laboratory research 显微镜 实验室 研究"},{"emoji": "🧫", "keywords": "petri dish culture biology 培养皿 培养 生物"},{"emoji": "🧬", "keywords": "dna genetics biology 基因 遗传 生物"},{"emoji": "🦠", "keywords": "microbe bacteria virus 微生物 细菌 病毒"},{"emoji": "🌡️", "keywords": "thermometer temperature 温度计 温度"},{"emoji": "☄️", "keywords": "comet meteor space 彗星 流星 太空"},{"emoji": "🪐", "keywords": "planet saturn space 行星 土星 太空"},{"emoji": "🛸", "keywords": "ufo flying saucer alien 飞碟 外星人"},{"emoji": "🌍", "keywords": "earth globe world 地球 世界"},{"emoji": "🗺️", "keywords": "map world geography 地图 世界 地理"},{"emoji": "🩺", "keywords": "stethoscope medicine health doctor 听诊器 医疗 健康 医生"}] },
  { id: "nature-animals", title: "Nature & Animals", keywords: "自然与动物", entries: [{"emoji": "🌱", "keywords": "seedling sprout growth 幼苗 萌芽 生长"},{"emoji": "🔥", "keywords": "fire flame heat 火 火焰 热"},{"emoji": "🐙", "keywords": "octopus ocean 章鱼 海洋"},{"emoji": "🦀", "keywords": "crab sea 螃蟹 海洋"},{"emoji": "🐝", "keywords": "bee honey insect 蜜蜂 蜂蜜 昆虫"},{"emoji": "🦊", "keywords": "fox animal 狐狸 动物"},{"emoji": "🌊", "keywords": "wave ocean water 海浪 海洋 水"},{"emoji": "🌙", "keywords": "moon crescent night 月亮 新月 夜晚"},{"emoji": "⚡️", "keywords": "lightning bolt electricity 闪电 电力"},{"emoji": "🍀", "keywords": "clover luck plant 四叶草 幸运 植物"},{"emoji": "🫧", "keywords": "bubbles foam 泡泡 泡沫"},{"emoji": "🧊", "keywords": "ice cold frozen 冰 寒冷 冰冻"},{"emoji": "🪵", "keywords": "wood log timber 木头 原木 木材"},{"emoji": "🪨", "keywords": "rock stone 石头 岩石"},{"emoji": "🌋", "keywords": "volcano eruption lava 火山 喷发 熔岩"},{"emoji": "🏔️", "keywords": "mountain snow peak 山 雪山 山峰"},{"emoji": "🌈", "keywords": "rainbow weather color 彩虹 天气 色彩"},{"emoji": "🌳", "keywords": "tree forest nature 树 森林 自然"},{"emoji": "🐱", "keywords": "cat kitten pet 猫 小猫 宠物"},{"emoji": "🐶", "keywords": "dog puppy pet 狗 小狗 宠物"},{"emoji": "🐼", "keywords": "panda bear 熊猫 动物"},{"emoji": "🐳", "keywords": "whale ocean spout 鲸鱼 海洋 喷水"},{"emoji": "🦉", "keywords": "owl bird night 猫头鹰 鸟 夜晚"},{"emoji": "🌻", "keywords": "sunflower flower plant 向日葵 花 植物"}] },
  { id: "everyday-life", title: "Everyday Life", keywords: "日常生活", entries: [{"emoji": "🪑", "keywords": "chair seat furniture 椅子 座位 家具"},{"emoji": "🛋️", "keywords": "couch sofa home 沙发 家居"},{"emoji": "🔦", "keywords": "flashlight torch light 手电筒 照明"},{"emoji": "🕯️", "keywords": "candle light 蜡烛 烛光"},{"emoji": "🚿", "keywords": "shower water wash 淋浴 水 洗澡"},{"emoji": "🛁", "keywords": "bathtub bath relax 浴缸 泡澡 放松"},{"emoji": "🧴", "keywords": "lotion bottle skincare 乳液 瓶子 护肤"},{"emoji": "🧹", "keywords": "broom sweep cleaning 扫帚 扫地 清洁"},{"emoji": "🧺", "keywords": "basket laundry 篮子 洗衣"},{"emoji": "🧼", "keywords": "soap wash cleaning 肥皂 洗涤 清洁"},{"emoji": "🪣", "keywords": "bucket pail water 水桶 桶 水"},{"emoji": "🧽", "keywords": "sponge scrub cleaning 海绵 擦洗 清洁"},{"emoji": "🪥", "keywords": "toothbrush teeth dental 牙刷 牙齿 口腔"},{"emoji": "🪒", "keywords": "razor shaving 剃须刀 刮胡子"},{"emoji": "⏰", "keywords": "alarm clock time 闹钟 时间"},{"emoji": "⏳", "keywords": "hourglass timer waiting 沙漏 计时 等待"},{"emoji": "🧳", "keywords": "luggage suitcase travel 行李箱 行李 旅行"},{"emoji": "🎒", "keywords": "backpack school bag 背包 书包 学校"},{"emoji": "☕", "keywords": "coffee cup hot drink 咖啡 杯子 热饮"},{"emoji": "🍎", "keywords": "apple fruit food 苹果 水果 食物"},{"emoji": "💰", "keywords": "money bag savings finance 钱 钱袋 储蓄 财务"},{"emoji": "🍋", "keywords": "lemon citrus fruit 柠檬 柑橘 水果"},{"emoji": "🍕", "keywords": "pizza food meal 披萨 食物 餐饮"},{"emoji": "🏠", "keywords": "house home building 房子 家 住宅"}] },
  { id: "leisure-entertainment", title: "Leisure & Entertainment", keywords: "休闲娱乐", entries: [{"emoji": "🕹️", "keywords": "joystick game arcade 摇杆 游戏 街机"},{"emoji": "🎯", "keywords": "target dart goal 靶心 飞镖 目标"},{"emoji": "🪄", "keywords": "magic wand 魔法 魔杖"},{"emoji": "🍿", "keywords": "popcorn movie snack 爆米花 电影 零食"},{"emoji": "🔮", "keywords": "crystal ball fortune magic 水晶球 占卜 魔法"},{"emoji": "⚔️", "keywords": "crossed swords battle 剑 战斗"},{"emoji": "🪓", "keywords": "axe chopping 斧头 劈砍"},{"emoji": "🗡️", "keywords": "dagger blade 匕首 刀刃"},{"emoji": "🏹", "keywords": "bow arrow archery 弓箭 射箭"},{"emoji": "🪃", "keywords": "boomerang throwing 回旋镖 投掷"},{"emoji": "🧿", "keywords": "nazar amulet evil eye 护身符 蓝眼"},{"emoji": "🎬", "keywords": "clapper movie film 场记板 电影 拍摄"},{"emoji": "🏕️", "keywords": "camping tent outdoors 露营 帐篷 户外"},{"emoji": "🧗", "keywords": "climbing climber sport 攀岩 攀登 运动"},{"emoji": "🪁", "keywords": "kite flying 风筝 放飞"},{"emoji": "🎲", "keywords": "dice game chance 骰子 游戏 随机"},{"emoji": "♟️", "keywords": "chess pawn board game 国际象棋 棋子 桌游"},{"emoji": "🧸", "keywords": "teddy bear toy 泰迪熊 玩具"},{"emoji": "🪩", "keywords": "disco mirror ball dance 迪斯科 镜球 舞蹈"},{"emoji": "🎺", "keywords": "trumpet brass music 小号 铜管 音乐"},{"emoji": "🎸", "keywords": "guitar rock music 吉他 摇滚 音乐"},{"emoji": "🥁", "keywords": "drum rhythm music 鼓 节奏 音乐"},{"emoji": "🏆", "keywords": "trophy winner award 奖杯 冠军 奖励"},{"emoji": "🥇", "keywords": "gold medal first winner 金牌 第一 冠军"},{"emoji": "🎵", "keywords": "music note melody 音乐 音符 旋律"}] },
  { id: "symbols-communication", title: "Symbols & Communication", keywords: "标记与沟通", entries: [{"emoji": "💎", "keywords": "diamond gem jewel 钻石 宝石 珠宝"},{"emoji": "⭐", "keywords": "star favorite rating 星星 收藏 评分"},{"emoji": "❤️", "keywords": "heart love like 心 爱 喜欢"},{"emoji": "💬", "keywords": "speech chat message 对话 聊天 消息"},{"emoji": "✉️", "keywords": "envelope mail letter 信封 邮件 信件"},{"emoji": "✅", "keywords": "check done complete success 勾选 完成 成功"},{"emoji": "🌐", "keywords": "globe web internet network 全球 网页 互联网 网络"},{"emoji": "🤝", "keywords": "handshake agreement collaboration 握手 协议 合作"}] },
];

/**
 * Frozen matchingEmojiGroups: a query naming a group title or its
 * keywords keeps every entry in it; otherwise entries match on the
 * emoji itself or a case-insensitive keyword substring. Groups with
 * no matching entries drop out entirely.
 */
export function matchingEmojiGroups(query: string): EmojiGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return EMOJI_GROUPS;
  return EMOJI_GROUPS.flatMap((group) => {
    const matchesCategory =
      group.title.toLowerCase().includes(needle) ||
      group.keywords.toLowerCase().includes(needle);
    const entries = group.entries.filter(
      (e) =>
        matchesCategory ||
        e.emoji.includes(needle) ||
        e.keywords.toLowerCase().includes(needle),
    );
    return entries.length > 0 ? [{ ...group, entries }] : [];
  });
}

/**
 * Stored icon value: the emoji mark verbatim. Nil clears back to the
 * folder mark. A bound on length and control characters keeps a
 * forged payload from smuggling markup into a row — any emoji,
 * catalogue or not, is accepted like the frozen free-form field.
 */
export function sanitizeIcon(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean === "" || clean.length > 32) return undefined;
  return clean;
}
