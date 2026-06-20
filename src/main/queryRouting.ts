export type QueryKind =
  | "realtime-fact"
  | "realtime-recommendation"
  | "local-action"
  | "static-knowledge"
  | "casual-chat";

const REALTIME_TIME_REGEX =
  /(今天|现在|当前|今日).*(日期|时间|几点|几号|星期几|周几|哪天)|((what|which)\s+day\s+is\s+it)|(today'?s?\s+date)|current\s+(date|time)/i;
const DIRECT_TIME_REGEX =
  /^(现在)?几点了[？?]?$|^(现在)?几点[？?]?$|^(当前|现在)?时间是?什么[？?]?$|^(今天)?几号[？?]?$|^(今天是)?几月几号[？?]?$|^(今天|现在|当前).*(时间|日期|星期几|周几|哪天|几点|几号)|^(what time is it|current time|current date|today'?s date|what day is it)[?.! ]*$/i;
const REALTIME_INFO_REGEX =
  /((今天|今日|当前|现在|最新|最近|实时|20\d{2}年?).*(股市|a股|港股|美股|股票|大盘|指数|行情|市场|新闻|资讯|汇率|金价|油价|热点|比赛|票房))|((股市|a股|港股|美股|股票|大盘|指数|行情|市场|新闻|资讯|汇率|金价|油价|热点).*(怎么样|如何|多少|走势|情况|消息|动态|表现))/i;
const RECOMMENDATION_CATEGORY_REGEX =
  /(手机|电脑|笔记本|平板|耳机|显卡|处理器|相机|电视|空调|冰箱|洗衣机|汽车|车型|餐厅|酒店|旅游|模型|ai 模型|ai模型)/i;
const RECOMMENDATION_INTENT_REGEX =
  /(最好|推荐|排行|排名|值得买|性价比|怎么选|选哪个|买哪个|哪款好|哪个好)/i;
const RECOMMENDATION_TIME_REGEX = /(今年|最近|最新|目前|现在|当前|20\d{2}年?)/i;
const TOOL_INTENT_REGEX =
  /(读取文件|读文件|写文件|创建文件|新建文件|保存文件|生成文件|删除文件|列出目录|搜索文件|桌面|电脑桌面|desktop|当前时间|当前日期|今天几号|今天是几号|今天几月几号|今天星期几|今天周几|今天是哪天|几号|几月几号|星期几|周几|日期|几点|计算|换算|单位|汇率|天气|联网|搜索|网页|链接|url|clipboard|copy|read file|write file|create file|new file|save file|delete file|list directory|search files|time|date|today|day of week|calculate|calculator|unit convert|currency|weather|web search|fetch|股市|a股|港股|美股|股票|大盘|指数|行情|新闻|资讯|上证|深证|沪深|金价|油价|生成pdf|生成ppt|生成报告|写报告|分析报告|投资报告|研究报告|pdf|ppt|pptx|报告|演示文稿|幻灯片)/i;
const CASUAL_CHAT_REGEX =
  /^(你好|您好|嗨|hi|hello|在吗|早上好|下午好|晚上好|谢谢|好的|ok|嗯|好)$/i;
const KNOWLEDGE_INTENT_REGEX =
  /(知识库|文档|文件|资料|材料|原文|上下文|根据|依据|上传|检索|查找|总结|概括|摘要|讲了什么|说了什么|主要内容|出处|来源|引用|pdf|word|docx|txt|表格|合同|手册|报告|政策|说明书)/i;

const LOCAL_SYSTEM_HINTS = [
  "我的电脑",
  "我这台电脑",
  "当前运行",
  "正在运行",
  "运行哪些软件",
  "开着哪些软件",
  "打开了哪些软件",
  "查看进程",
  "列出进程",
  "查看软件",
  "查看应用",
  "task manager",
  "process",
  "processes",
  "running apps",
  "running programs",
];

export function isCasualChatQuery(message: string): boolean {
  return CASUAL_CHAT_REGEX.test(message.trim().toLowerCase());
}

export function isDirectCurrentTimeQuery(message: string): boolean {
  return DIRECT_TIME_REGEX.test(message.trim().toLowerCase());
}

export function isRealtimeFactQuery(message: string): boolean {
  const text = message.trim().toLowerCase();
  return REALTIME_TIME_REGEX.test(text) || isDirectCurrentTimeQuery(text);
}

export function isRealtimeRecommendationQuery(message: string): boolean {
  return (
    RECOMMENDATION_CATEGORY_REGEX.test(message) &&
    RECOMMENDATION_INTENT_REGEX.test(message) &&
    RECOMMENDATION_TIME_REGEX.test(message)
  );
}

export function shouldUseWebSearchForQuery(message: string): boolean {
  return REALTIME_INFO_REGEX.test(message) || isRealtimeRecommendationQuery(message);
}

export function isLocalActionQuery(message: string): boolean {
  return (
    TOOL_INTENT_REGEX.test(message) ||
    LOCAL_SYSTEM_HINTS.some((hint) => message.includes(hint))
  );
}

export function isKnowledgeBaseQuery(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text || isCasualChatQuery(text)) return false;
  return KNOWLEDGE_INTENT_REGEX.test(text);
}

export function detectQueryKinds(message: string): Set<QueryKind> {
  const kinds = new Set<QueryKind>();
  if (isCasualChatQuery(message)) {
    kinds.add("casual-chat");
  }
  if (isRealtimeFactQuery(message)) {
    kinds.add("realtime-fact");
  }
  if (isRealtimeRecommendationQuery(message)) {
    kinds.add("realtime-recommendation");
  }
  if (isLocalActionQuery(message)) {
    kinds.add("local-action");
  }
  if (!kinds.size) {
    kinds.add("static-knowledge");
  }
  return kinds;
}
