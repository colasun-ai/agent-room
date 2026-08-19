import type { Language } from './model'

const en = {
  navHome: 'Home', navNew: 'New room', navSettings: 'Settings', navAbout: 'About', beta: 'PUBLIC BETA',
  heroEyebrow: 'A tiny room for big ideas', heroTitle: 'Create agents. Put them in a room. Watch them talk.',
  heroBody: 'A real multi-agent conversation, streamed turn by turn. No sign-up. Your room history stays on this device.', startRoom: 'Start a room',
  roomSetup: 'Room setup', preferences: 'Preferences', startupTitle: 'Startup Team', startupDesc: 'Shape a product with a pragmatic founding team.', debateTitle: 'Debate', debateDesc: 'Explore a difficult choice from opposing views.', buildTitle: 'Build Something', buildDesc: 'Turn an idea into an actionable build plan.',
  templates: 'Pick a starting point', recentRooms: 'Recent rooms', noRooms: 'Your rooms will appear here — only on this device.', openRoom: 'Open room',
  newRoom: 'Create a room', roomTitle: 'Room title', topic: 'Discussion topic', agents: 'Agents', runLength: 'First run', turns: 'turns',
  addAgent: 'Add agent', removeAgent: 'Remove', name: 'Name', role: 'Role', avatar: 'Avatar', personality: 'Personality', goal: 'Goal',
  advanced: 'Advanced', custom: 'Custom instructions', temperature: 'Creativity', enabled: 'Enabled', createStart: 'Create & start', creating: 'Starting…',
  agentRule: 'Enable 2–6 agents with unique names.', back: 'Back', agentRail: 'Room agents', controls: 'Controls', totalTurns: 'Total turns',
  pause: 'Pause', resume: 'Resume', stop: 'Stop current turn', retry: 'Retry', skip: 'Skip', keepPartial: 'Keep partial',
  continueRun: 'Continue', messagePlaceholder: 'Message the room — try @Name…', send: 'Send', jumpBottom: 'Back to latest', menu: 'Room menu',
  emptyChat: 'The room is ready. The first agent will join when the run starts.', waiting: 'is waiting for shared capacity…', thinking: 'is thinking…',
  busy: 'Public demo is busy · shared AI capacity', interrupted: 'This response was interrupted.', failed: 'couldn’t respond.', stopped: 'Current turn stopped.',
  follower: 'Another tab is driving this room. Updates will appear here.', settings: 'Settings', appearance: 'Appearance', language: 'Language', dataPrivacy: 'Data & privacy',
  system: 'System', light: 'Light', dark: 'Dark', english: 'English', chinese: '简体中文', clearData: 'Clear local data',
  clearExplain: 'Permanently removes rooms, agents, runs, and message history from this browser.', clearConfirm: 'Clear everything on this device?', cancel: 'Cancel', clear: 'Clear data',
  privacyText: 'History is stored on this device. To generate a reply, the necessary current text is temporarily sent through Cloudflare to NVIDIA. The server keeps only minimal anonymous session, quota, and room-control metadata — never your conversation body.',
  about: 'About AgentRoom', aboutBody: 'AgentRoom is an open-source, text-only multi-agent chat experiment. One server-selected agent speaks per real streamed turn.',
  noSignup: 'No sign-up', localFirst: 'Local history', sharedCapacity: 'Shared public capacity', source: 'Source code', deployOwn: 'Deploy your own',
  anonymousExplain: 'An anonymous server session exists only for abuse prevention and fair capacity.', capacityExplain: 'Availability may vary. This public NVIDIA-backed demo has a deliberately conservative shared limit.',
  deleteRoom: 'Delete room', deleteConfirm: 'Delete this room and all of its local history?', notFound: 'Room not found', home: 'Go home',
  editAgents: 'Edit agents', save: 'Save changes', close: 'Close', draft: 'Draft', running: 'Running', paused: 'Paused', finished: 'Finished', error: 'Needs attention',
} as const

const zh: Record<keyof typeof en, string> = {
  navHome: '首页', navNew: '新建房间', navSettings: '设置', navAbout: '关于', beta: '公开测试版',
  heroEyebrow: '让不同视角共处一室', heroTitle: '创建 Agent，把它们放进房间，看它们真正对话。',
  heroBody: '逐轮实时生成的多 Agent 对话。无需注册，房间历史只保存在此设备。', startRoom: '创建房间',
  roomSetup: '房间设置', preferences: '偏好设置', startupTitle: '创业团队', startupDesc: '和务实的创始团队一起打磨产品。', debateTitle: '观点辩论', debateDesc: '从对立视角探索一个困难选择。', buildTitle: '一起创造', buildDesc: '把想法变成可执行的构建计划。',
  templates: '选择一个起点', recentRooms: '最近房间', noRooms: '你的房间会显示在这里，并且只留在此设备。', openRoom: '打开房间',
  newRoom: '创建房间', roomTitle: '房间标题', topic: '讨论主题', agents: 'Agents', runLength: '首轮对话', turns: '轮',
  addAgent: '添加 Agent', removeAgent: '移除', name: '名字', role: '角色', avatar: '头像', personality: '性格', goal: '目标',
  advanced: '高级设置', custom: '补充指令', temperature: '创造性', enabled: '启用', createStart: '创建并开始', creating: '正在启动…',
  agentRule: '请启用 2–6 个 Agent，且名字不能重复。', back: '返回', agentRail: '房间 Agents', controls: '控制', totalTurns: '累计轮次',
  pause: '暂停', resume: '继续', stop: '停止当前回复', retry: '重试', skip: '跳过', keepPartial: '保留片段',
  continueRun: '继续', messagePlaceholder: '给房间发消息，也可以试试 @名字…', send: '发送', jumpBottom: '回到最新消息', menu: '房间菜单',
  emptyChat: '房间已准备好。运行开始后，第一位 Agent 会加入讨论。', waiting: '正在等待共享容量…', thinking: '正在思考…',
  busy: '公共体验繁忙 · 共享 AI 容量', interrupted: '这条回复被中断了。', failed: '未能回复。', stopped: '当前回复已停止。',
  follower: '另一个标签页正在驱动此房间，更新会自动同步到这里。', settings: '设置', appearance: '外观', language: '语言', dataPrivacy: '数据与隐私',
  system: '跟随系统', light: '浅色', dark: '深色', english: 'English', chinese: '简体中文', clearData: '清除本地数据',
  clearExplain: '永久删除此浏览器中的房间、Agents、运行记录和消息历史。', clearConfirm: '确定清除此设备上的全部数据吗？', cancel: '取消', clear: '清除数据',
  privacyText: '历史记录保存在此设备。生成回复时，当前所需文本会经 Cloudflare 临时转发给 NVIDIA。服务端仅保留匿名会话、额度与房间控制所需的最少元数据，绝不持久化聊天正文。',
  about: '关于 AgentRoom', aboutBody: 'AgentRoom 是一个开源、纯文本的多 Agent 群聊实验。每一轮都由服务端选择一位 Agent，并真实流式生成。',
  noSignup: '无需注册', localFirst: '历史仅在本地', sharedCapacity: '共享公共容量', source: '查看源码', deployOwn: '自行部署',
  anonymousExplain: '匿名服务端会话仅用于防滥用与公平分配共享容量。', capacityExplain: '可用性可能波动。此 NVIDIA 公共体验采用了审慎的共享额度限制。',
  deleteRoom: '删除房间', deleteConfirm: '删除此房间及其全部本地历史吗？', notFound: '未找到房间', home: '回到首页',
  editAgents: '编辑 Agents', save: '保存修改', close: '关闭', draft: '草稿', running: '运行中', paused: '已暂停', finished: '已结束', error: '需要处理',
}

export type TranslationKey = keyof typeof en
export function translator(language: Language): (key: TranslationKey) => string { const table = language === 'zh' ? zh : en; return (key) => table[key] }
