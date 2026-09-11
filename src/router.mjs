import path from "node:path";
import { readAgentSections, readCanonicalText, readMenuRules, readWinningSkillMetadata, resolveCanonicalSources, sourceSummary } from "./canonical-sources.mjs";
import { createAuthorityRevision } from "./worker/authority.mjs";

const BASE_POLICY_SECTIONS = [
	"Policy Authority & Model Selection",
	"Skills, Menu & Historical Memory",
	"Runtime Capability Truth",
	"External Actions & Standing Local Delegation",
];

const PROFILE_RULES = [
	{
		profile: "readonly",
		keywords: ["只读", "read-only", "readonly", "审阅", "审查", "audit", "review", "inspect", "验证"],
		sections: [...BASE_POLICY_SECTIONS, "Human Reviewability"],
	},
	{
		profile: "web",
		keywords: ["web", "search", "最新", "新闻", "资料", "github", "网页", "联网", "research", "来源", "深度研究", "调研", "竞品", "尽调", "竞争格局"],
		sections: BASE_POLICY_SECTIONS,
	},
	{
		profile: "data",
		keywords: ["数据源", "采集", "获取数据", "开放数据", "csv", "excel", "rss", "dataset", "ingest", "ingestion", "etl", "provenance", "freshness"],
		sections: BASE_POLICY_SECTIONS,
	},
	{
		profile: "long",
		keywords: ["长期", "长任务", "goal", "todo", "计划", "milestone", "background", "持续"],
		sections: [...BASE_POLICY_SECTIONS, "Long-Task Execution Economy", "Worklog & Runtime Security Boundaries"],
	},
	{
		profile: "agent",
		keywords: ["agent", "subagent", "swarm", "scout", "coder", "多智能体", "并行", "reviewer", "worker"],
		sections: [...BASE_POLICY_SECTIONS, "Multi-Agent & Task-Owned Process Lifecycle", "Long-Task Execution Economy"],
	},
	{
		profile: "browser",
		keywords: ["browser", "浏览器", "dom", "网页操作", "登录", "e2e", "截图", "页面"],
		sections: BASE_POLICY_SECTIONS,
	},
	{
		profile: "computer",
		keywords: ["computer use", "computer-use", "电脑操作", "桌面操作", "windows settings", "计算器", "记事本", "file explorer", "文件资源管理器", "native app", "desktop app", "窗口操作", "鼠标", "键盘"],
		sections: [...BASE_POLICY_SECTIONS, "Human Reviewability"],
	},
	{
		profile: "academic",
		keywords: ["academic", "学术", "论文", "paper", "manuscript", "nature", "arxiv", "期刊", "文献"],
		sections: BASE_POLICY_SECTIONS,
	},
	{
		profile: "lean",
		keywords: ["代码", "code", "implement", "实现", "构建", "开发", "新增", "添加", "修复", "refactor", "工程", "build"],
		sections: [...BASE_POLICY_SECTIONS, "Coding Defaults", "Human Reviewability"],
	},
];

const PROFILE_CAPABILITY_OWNERS = {
	readonly: ["read-only inspection"],
	web: ["pi-web-access"],
	data: ["structured data acquisition"],
	long: ["goal/task continuity"],
	agent: ["agent coordination"],
	browser: ["browser execution"],
	computer: ["desktop computer execution"],
	academic: ["academic source workflow"],
	lean: ["core engineering tools"],
};

function lower(value) {
	return String(value || "").toLowerCase();
}

function keywordMatchesQuery(query, keyword) {
	const normalized = lower(keyword).trim();
	if (!normalized) return false;
	if (!/[a-z0-9]/i.test(normalized)) return query.includes(normalized);
	const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(query);
}

function promptTerms(prompt) {
	return [...new Set(lower(prompt).match(/[\p{Script=Han}]{2,}|[a-z][a-z0-9+.-]{2,}/gu) || [])];
}

function semanticPromptText(prompt) {
	return String(prompt || "")
		.replace(/@?["'`]?[a-z]:[\\/][^<>|?*"'`\r\n]*?\.(?:md|mdx|txt|json|ya?ml|toml|ts|tsx|js|mjs|cjs|py|rs|go|java|kt|swift|cpp|c|h|hpp|css|scss|html|vue|svelte|docx?|xlsx?|xlsm|pptx?|pptm|pdf|odt|ods|odp|csv|mov|mp4|mkv|avi|png|jpe?g|webp)(?=$|["'`\s，。；、）)\]}]|\p{Script=Han})/giu, " ")
		.replace(/@?[a-z]:[\\/][^<>|?*"'`\r\n]*?(?=\s+(?:的|目录|文件|仓库|项目|当前|现有|并且|并|然后|随后|再|后|中|里|下|上)|[，。；、]|$)/giu, " ")
		.replace(/[a-z]:[\\/][^\s"'`<>]+/giu, " ")
		.replace(/[^\s"'`<>]+\.(?:md|mdx|txt|json|ya?ml|toml|ts|tsx|js|mjs|cjs|py|rs|go|java|kt|swift|cpp|c|h|hpp|css|scss|html|vue|svelte)\b/giu, " ");
}

function hanText(value) {
	return (String(value || "").match(/\p{Script=Han}/gu) || []).join("");
}

function hasCommonHanSpan(left, right, minimum = 4) {
	const a = hanText(left);
	const b = hanText(right);
	if (a.length < minimum || b.length < minimum) return false;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	for (let size = Math.min(shorter.length, 12); size >= minimum; size -= 1) {
		for (let index = 0; index + size <= shorter.length; index += 1) {
			if (longer.includes(shorter.slice(index, index + size))) return true;
		}
	}
	return false;
}

function hanBigrams(value) {
	const result = new Set();
	for (const segment of String(value || "").match(/\p{Script=Han}{2,}/gu) || []) {
		for (let index = 0; index + 2 <= segment.length; index += 1) result.add(segment.slice(index, index + 2));
	}
	return result;
}

function buildMenuEvidence(menu) {
	const tokenFrequency = new Map();
	const hanFrequency = new Map();
	const skillPrefixFrequency = new Map();
	for (const rule of menu?.rules || []) {
		const tokens = new Set();
		const hanTerms = new Set();
		for (const keyword of rule.keywords || []) {
			for (const token of promptTerms(keyword)) tokens.add(token);
			for (const term of hanBigrams(keyword)) hanTerms.add(term);
		}
		for (const token of tokens) tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
		for (const term of hanTerms) hanFrequency.set(term, (hanFrequency.get(term) || 0) + 1);
		for (const skill of rule.skills || []) {
			const firstPart = lower(skill).split(/[^a-z0-9]+/u)[0];
			if (firstPart?.length >= 3) skillPrefixFrequency.set(firstPart + "-", (skillPrefixFrequency.get(firstPart + "-") || 0) + 1);
		}
	}
	return { tokenFrequency, hanFrequency, skillPrefixFrequency };
}

function skillPrefixSignals(query, rule, evidence) {
	const terms = promptTerms(query);
	return (rule.skills || []).flatMap((skill) => {
		const normalized = lower(skill);
		return terms
			.filter((term) => term.length >= 3 && normalized.startsWith(term + "-"))
			.map((term) => ({ term, unique: (evidence.skillPrefixFrequency.get(term + "-") || 0) <= 1 }));
	});
}

function ruleMatchesPrompt(query, rule, evidence = buildMenuEvidence({ rules: [rule] })) {
	const exact = (rule.keywords || []).filter((keyword) => keywordMatchesQuery(query, keyword));
	const exactAscii = exact.filter((keyword) => /[a-z0-9]/i.test(keyword) && lower(keyword).length >= 3);
	const skillPrefixSignal = skillPrefixSignals(query, rule, evidence);
	if (exactAscii.some((keyword) => (evidence.tokenFrequency.get(lower(keyword)) || 0) <= 1) || exactAscii.length >= 2 || (exactAscii.length > 0 && skillPrefixSignal.some((signal) => signal.unique))) return true;
	if (exact.some((keyword) => hanText(keyword).length >= 3)) return true;
	// A standalone two-character Menu term can still be a useful sparse alias or
	// exception hint. Capability semantics remain in Skill metadata, not here.
	if (exact.some((keyword) => hanText(keyword).length === 2 && ((evidence.hanFrequency.get(hanText(keyword)) || 0) <= 1 || skillPrefixSignal.length > 0))) return true;
	return hasCommonHanSpan(query, rule.entry, 4);
}

function wholeTaskReadonlyIntent(query) {
	const text = String(query || "");
	const noMutationSource = [
		"(?:禁止|不要|不得|不许|别|无需|不用|不必).{0,8}(?:再)?(?:做|进行)?(?:任何)?(?:修改|改动|更改|改|更新|写入|写|编辑|动|碰|删除|移除|新建|创建)(?:.{0,12}(?:任何)?(?:文件|代码|内容|本地状态))?",
		"不(?=(?:修改|改动|更改|改|更新|写入|写|编辑|动|碰|删除|移除|新建|创建))(?:修改|改动|更改|改|更新|写入|写|编辑|动|碰|删除|移除|新建|创建)(?:.{0,12}(?:任何)?(?:文件|代码|内容|本地状态))?",
		"(?:do\\s+not|don't|never).{0,10}(?:make\\s+)?(?:any\\s+)?(?:modify|change|update|write|edit|delete|create|touch)(?:.{0,16}(?:anything|any\\s+files?|files?|code|content|local\\s+state))?",
		"without\\s+(?:making\\s+)?(?:any\\s+)?(?:changes?|writes?|edits?|mutations?)",
		"\\bno\\s+(?:changes?|writes?|edits?|mutations?)\\b",
	].join("|");
	const analysisOnlySource = "(?:只|仅)(?:做|进行)?(?:分析|审查|审计|检查|查看|阅读)(?=$|[，,；;。\\s])|\\b(?:analy[sz]e|review|inspect)\\s+only\\b";
	const explicitNoMutation = new RegExp(noMutationSource, "iu").test(text) || new RegExp(analysisOnlySource, "iu").test(text);
	const positiveText = text
		.replace(new RegExp(noMutationSource, "giu"), " ")
		.replace(new RegExp(analysisOnlySource, "giu"), " ");
	const positivePersistentOutput = /(?:生成|新建|创建|写入|保存|另存(?:为)?|导出|修改|更新|删除|移除|create\b|generate\b|write\b|save\b|export\b|modify\b|update\b|delete\b|remove\b)/iu.test(positiveText);
	if (explicitNoMutation && !positivePersistentOutput && !localCommandExecutionIntent(text)) return true;
	const marker = /(?:只读(?!取)|read-only|readonly)/iu.test(text);
	if (marker && !/(?:修复|重构|修改|新增|添加|fix\b|refactor\b|write\b|implement\b|build\b|coder\b)/iu.test(text)) return true;
	return /(?:只读(?!取)|read-only|readonly).{0,40}(?:整个(?:项目|任务|仓库)?|全程|(?:禁止|不(?:要|得|许)?|别)(?:修改|改|写)|(?:no|without)\s+(?:changes?|writes?|mutation)|do\s+not\s+(?:change|modify|write))|(?:(?:禁止|不(?:要|得|许)?|别)(?:修改|改|写).{0,32}(?:只读(?!取)|审计|审查|review|audit)|(?:read-only|readonly).{0,12}(?:only|throughout))/iu.test(text);
}

function wholeTaskMutationProhibitedIntent(query) {
	const text = String(query || "");
	const prohibition = /(?:禁止|不要|不得|不许|别|无需|不用|不必|不).{0,8}(?:再)?(?:做|进行)?(?:任何)?(?:修改|改动|更改|更新|写入|编辑|删除|移除|新建|创建)(?:.{0,16}(?:任何)?(?:文件|代码|源码|内容|本地状态))?|(?:do\s+not|don't|never|without).{0,12}(?:make\s+)?(?:any\s+)?(?:modify|change|update|write|edit|delete|create|touch|changes?|writes?|edits?|mutations?)/iu.test(text);
	if (!prohibition) return false;
	const positivePersistentOutput = /(?:生成|新建|创建|写入|保存|另存(?:为)?|导出|输出(?:到|至)|create\b|generate\b|write\b|save\b|export\b)/iu.test(positiveLocalMutationText(text));
	const sourceSpecific = /(?:禁止|不要|不得|不许|别|不).{0,8}(?:修改|改动|更改|更新|写入|编辑|删除|移除).{0,48}(?:原文件|源文件|source\s+file|[a-z]:[\\/])/iu.test(text);
	return !(positivePersistentOutput && sourceSpecific);
}

function negatedWritingArtifactIntent(query) {
	return /(?:不需要|无需|不用|不要|不必).{0,8}(?:写|撰写|起草|编写|改写|润色|修订|修改|完善).{0,32}(?:方案|文档|说明|报告|论文|摘要|文章|文案|邮件|消息|通知|公告|访谈稿|新闻稿|总结|声明|文字|文本)/iu.test(String(query || ""));
}

function writingArtifactIntent(query) {
	const text = String(query || "").trim();
	const artifact = /(?:方案|文档|说明|报告|论文|摘要|文章|文案|邮件|消息|通知|公告|访谈稿|新闻稿|总结|声明|文字|文本)/iu;
	const writeAction = /(?:写|撰写|起草|编写|改写|润色|审阅|修订|修改|完善|整理)/iu;
	return !negatedWritingArtifactIntent(text) && writeAction.test(text) && artifact.test(text);
}

function primaryWritingArtifactIntent(query) {
	const text = String(query || "").trim();
	const writingLead = /^(?:请|帮我|帮忙|麻烦)?\s*(?:(?:先|首先)\s*)?(?:继续\s*)?(?:写|撰写|起草|编写|改写|润色|审阅|修订|修改|完善|整理).{0,56}(?:方案|文档|说明|报告|论文|摘要|文章|文案|邮件|消息|通知|公告|访谈稿|新闻稿|总结|声明|文字|文本)/iu.test(text);
	if (!writingLead) return false;
	// 顺序型“先写方案 -> 然后实现”当前责任仍是写方案；后续责任会在
	// Worker/Todo 边界重新 route。并行型“写方案并实现”则仍按复合工程责任处理。
	if (/(?:然后|随后|再|之后|完成后).{0,32}(?:实现|开发|修复|重构|修改|新增|添加).{0,24}(?:代码|功能|模块|系统|服务|接口|页面|程序|机制|应用)/iu.test(text)) return true;
	return !/(?:并且|并|同时).{0,24}(?:实现|开发|修复|重构|修改|新增|添加).{0,20}(?:代码|功能|模块|系统|服务|接口|页面|程序|机制|应用)/iu.test(text);
}

function descriptionOwnsWritingArtifact(skill) {
	const positiveDescription = String(skill?.description || "")
		.split(/(?<=[.!?;。；])\s*/u)
		.filter((sentence) => !/(?:\bdo not\b|\bdon't\b|\bdoes not\b|\bnot for\b|\bnever\b|\bavoid\b|禁止|不要|不适用|不用于)/iu.test(sentence))
		.join(" ");
	return /(?:中文写作|写作|成品文本|撰写|起草|改写|润色|writing|drafting|rewrite|rewriting|polish|editing)/iu.test(positiveDescription);
}

function primaryAcademicSearchIntent(query) {
	const text = String(query || "");
	const search = /(?:搜索|检索|查找|查询|搜集|调研|literature\s+search|academic\s+search|search|retrieve|lookup)/iu;
	const academic = /(?:论文|文献|期刊|引用|引文|citation|citations|literature|paper|papers|journal|pubmed|arxiv|nature)/iu;
	return search.test(text) && academic.test(text);
}

function descriptionOwnsAcademicSearch(skill) {
	const positiveDescription = String(skill?.description || "")
		.split(/(?<=[.!?;。；])\s*/u)
		.filter((sentence) => !/(?:\bdo not\b|\bdon't\b|\bdoes not\b|\bnot for\b|\bnever\b|\bavoid\b|禁止|不要|不适用|不用于)/iu.test(sentence))
		.join(" ");
	return /(?:academic|literature|论文|文献).{0,80}(?:search|检索|搜索|citation|引用)|(?:search|检索|搜索|citation|引用).{0,80}(?:academic|literature|论文|文献)/iu.test(positiveDescription);
}

function primaryUiOrchestrationIntent(query) {
	const text = String(query || "");
	const ui = /(?:前端|frontend|\bui\b|dashboard|页面|界面)/iu.test(text);
	const multiple = /(?:多个|多种|多套|组合|协调|编排|multiple|combine|coordinate|orchestrat)/iu.test(text);
	const resources = /(?:库|组件基础|design\s*skill|设计\s*skill|设计资源|设计系统|libraries?|component\s+foundations?|design\s+systems?)/iu.test(text);
	return ui && multiple && resources;
}

function descriptionOwnsUiOrchestration(skill) {
	const positiveDescription = String(skill?.description || "")
		.split(/(?<=[.!?;。；])\s*/u)
		.filter((sentence) => !/(?:\bdo not\b|\bdon't\b|\bdoes not\b|\bnot for\b|\bnever\b|\bavoid\b|禁止|不要|不适用|不用于)/iu.test(sentence))
		.join(" ");
	const orchestration = /(?:orchestrat|协调|编排|组合设计)/iu.test(positiveDescription);
	const multipleResources = /(?:multiple.{0,32}(?:ui\s+)?libraries|design\s+skills|component\s+foundations|多个.{0,24}(?:库|设计资源|设计系统))/iu.test(positiveDescription);
	return orchestration && multipleResources;
}

function genericRasterImageIntent(query) {
	const text = String(query || "");
	return /(?:生成|创建|制作|做|绘制|修改|编辑|变换|处理).{0,20}(?:图片|图像|照片|插画)|(?:图片|图像|照片|插画).{0,20}(?:生成|创建|制作|做|绘制|修改|编辑|变换|处理)|(?:generate|create|make|draw|edit|modify|transform).{0,32}(?:image|photo|illustration)|(?:image|photo|illustration).{0,32}(?:generate|create|make|draw|edit|modify|transform)/iu.test(text);
}

function primaryPosterIntent(query) {
	return /(?:海报|poster)/iu.test(String(query || ""));
}

function descriptionOwnsPoster(skill) {
	const positiveDescription = String(skill?.description || "")
		.split(/(?<=[.!?;。；])\s*/u)
		.filter((sentence) => !/(?:\bdo not\b|\bdon't\b|\bdoes not\b|\bnot for\b|\bnever\b|\bavoid\b|禁止|不要|不适用|不用于)/iu.test(sentence))
		.join(" ");
	return /(?:海报|poster)/iu.test(positiveDescription);
}

function descriptionOwnsGenericRasterImages(skill) {
	const positiveDescription = String(skill?.description || "")
		.split(/(?<=[.!?;。；])\s*/u)
		.filter((sentence) => !/(?:\bdo not\b|\bdon't\b|\bdoes not\b|\bnot for\b|\bnever\b|\bavoid\b|禁止|不要|不适用|不用于)/iu.test(sentence))
		.join(" ");
	const genericRasterClass = /(?:raster\s+images?|bitmap\s+visuals?|通用.{0,8}(?:图片|图像)|(?:图片|图像).{0,12}(?:生成|创建).{0,12}(?:编辑|修改)|(?:生成|创建).{0,12}(?:编辑|修改).{0,12}(?:图片|图像))/iu.test(positiveDescription);
	const broadCreate = /(?:generate|create|edit|transform|生成|创建|编辑|变换)/iu.test(positiveDescription);
	const assetClasses = [
		/(?:photos?|照片)/iu,
		/(?:illustrations?|插画)/iu,
		/(?:textures?|纹理)/iu,
		/(?:sprites?|精灵)/iu,
		/(?:mockups?|模型图|样机)/iu,
		/(?:transparent-background|透明背景)/iu,
	].filter((pattern) => pattern.test(positiveDescription)).length;
	return genericRasterClass && broadCreate && assetClasses >= 2;
}

function descriptionOwnsGeneralDocumentWriting(skill) {
	const positiveDescription = String(skill?.description || "")
		.split(/(?<=[.!?;。；])\s*/u)
		.filter((sentence) => !/(?:\bdo not\b|\bdon't\b|\bdoes not\b|\bnot for\b|\bnever\b|\bavoid\b|禁止|不要|不适用|不用于)/iu.test(sentence))
		.join(" ");
	return /(?:方案|文档|说明|报告|总结|worklog|readme|design\s+document|technical\s+document|report|proposal)/iu.test(positiveDescription);
}

function descriptionOwnsCompletionVerification(skill) {
	const positiveDescription = String(skill?.description || "")
		.split(/(?<=[.!?;。；])\s*/u)
		.filter((sentence) => !/(?:\bdo not\b|\bdon't\b|\bdoes not\b|\bnot for\b|\bnever\b|\bavoid\b|禁止|不要|不适用|不用于)/iu.test(sentence))
		.join(" ");
	return /(?:completion\s+verification|完成验证|完成证据|验收|before\s+claiming.{0,32}(?:complete|fixed|passing|ready))/iu.test(positiveDescription);
}

function responsibilityAlignmentScore(skill, prompt) {
	const query = lower(prompt);
	if (primaryAcademicSearchIntent(query)) {
		if (descriptionOwnsAcademicSearch(skill)) return 120;
		if (descriptionOwnsWritingArtifact(skill)) return -80;
	}
	if (primaryPosterIntent(query)) {
		if (descriptionOwnsPoster(skill)) return 140;
	} else if (genericRasterImageIntent(query)) {
		if (descriptionOwnsGenericRasterImages(skill)) return 120;
		if (descriptionOwnsWritingArtifact(skill)) return -80;
	}
	if (!descriptionOwnsWritingArtifact(skill)) return 0;
	if (writingArtifactIntent(query)) {
		if (/(?:方案|文档|说明|报告|总结|worklog|readme)/iu.test(query) && descriptionOwnsGeneralDocumentWriting(skill)) return 100;
		return 40;
	}
	if (confirmedReadonlyResponsibility(query)) return -40;
	return 0;
}

function mutationIntent(query) {
	const wholeReadonly = wholeTaskReadonlyIntent(query);
	const confirmedReadonly = confirmedReadonlyResponsibility(query);
	const positiveQuery = positiveLocalMutationText(query);
	const readOnlySignal = wholeReadonly || /(?:审阅|审查|audit|review|inspect|验证)/i.test(query);
	const explicitMutation = /(?:修复|重构|修改|新增|添加|coder\b|mutation\b|fix\b|refactor\b|write\b)/i.test(positiveQuery);
	const chineseImplementation = /(?:实现|构建|开发)(?:(?:并|和|及|同时).{0,8})?(?:一个|一套|该|此|这个|那个|新的|生产|代码|功能|需求|系统|模块|接口|api|服务|页面|流程|工具|程序|机制|应用|模型|认证|授权|登录|支付|安全)/i.test(positiveQuery);
	const implementation = chineseImplementation || /(?:implement\b|build\b)/i.test(query);
	if (wholeReadonly) return false;
	if (localArtifactMutationIntent(query)) return true;
	if (confirmedReadonly) return false;
	if (primaryWritingArtifactIntent(query)) return false;
	return explicitMutation || chineseImplementation || (implementation && !readOnlySignal);
}

function engineeringMutationIntent(query) {
	const text = String(query || "");
	if (primaryWritingArtifactIntent(text)) return false;
	const sourceFileMutation = /(?:修复|重构|修改|新增|添加|实现|构建|开发|fix\b|refactor\b|modify\b|edit\b|write\b|implement\b|build\b).{0,96}\.(?:[cm]?[jt]sx?|mjs|cjs|py|rs|go|java|kt|swift|cpp|cc|cxx|c|h|hpp|cs|fs|php|rb|sh|ps1|sql|css|scss|html|vue|svelte)\b|\.(?:[cm]?[jt]sx?|mjs|cjs|py|rs|go|java|kt|swift|cpp|cc|cxx|c|h|hpp|cs|fs|php|rb|sh|ps1|sql|css|scss|html|vue|svelte)\b.{0,96}(?:修复|重构|修改|新增|添加|实现|构建|开发|fix\b|refactor\b|modify\b|edit\b|write\b|implement\b|build\b)/iu.test(text);
	if (sourceFileMutation) return true;
	return /(?:修复|重构|修改|新增|添加|实现|构建|开发).{0,32}(?:代码|源码|函数|类|模块|接口|api|服务|脚本|测试|组件|程序|功能|页面|数据库)|(?:代码|源码|函数|类|模块|接口|api|服务|脚本|测试|组件|程序|功能|页面|数据库).{0,32}(?:修复|重构|修改|新增|添加|实现|构建|开发)|(?:fix|refactor|modify|edit|write|implement|build).{0,32}(?:code|source|function|class|module|service|script|test|component|program|feature)|(?:code|source|function|class|module|service|script|test|component|program|feature).{0,32}(?:fix|refactor|modify|edit|write|implement|build)/iu.test(text);
}

function confirmedReadonlyResponsibility(query) {
	const text = String(query || "").trim();
	if (wholeTaskReadonlyIntent(text)) return true;
	const informational = /^(?:请|帮我|帮忙|麻烦)?\s*(?:解释|说明|分析|审查|审阅|检查|查看|读取|阅读|总结|比较|评估|诊断|研究|查找|查询|搜索|why\b|what\b|how\b|explain\b|analy[sz]e\b|review\b|audit\b|inspect\b|read\b|summari[sz]e\b|compare\b|evaluate\b|diagnose\b|research\b|search\b)/iu.test(text);
	if (!informational) return false;
	// A compound responsibility such as "review, then change ..." is not
	// mechanically readonly even when its first clause is informational.
	return !/(?:并且|并|然后|随后|再|同时|之后|\band\b|\bthen\b|\bafter(?:wards)?\b)/iu.test(text);
}

function localExecutionObjectIntent(query) {
	return /(?:代码|源码|文件|配置|仓库|项目|目录|路径|文档|表格|电子表格|演示文稿|图片|图像|照片|视频|模块|函数|类|接口|脚本|测试|依赖|组件|服务|数据库|表结构|\bcode\b|\bsource\b|\bfile\b|\bconfig\b|\brepo(?:sitory)?\b|\bproject\b|\bdirectory\b|\bpath\b|\bdocument\b|\bspreadsheet\b|\bpresentation\b|\bimage\b|\bphoto\b|\bvideo\b|\bword\b|\bexcel\b|\bpowerpoint\b|\bpdf\b|\bmodule\b|\bfunction\b|\bclass\b|\bapi\b|\bscript\b|\btest\b|\bdependency\b|\bcomponent\b|\bservice\b|\bparser\b|\.(?:docx?|xlsx?|xlsm|pptx?|pptm|pdf|odt|ods|odp|csv|mov|mp4|mkv|avi|png|jpe?g|webp)\b)/iu.test(String(query || ""));
}

function workspaceRelativeArtifactLocatorIntent(query) {
	return /(?:^|[\s"'`（(，,])(?:\.{0,2}[\\/])?[^\s"'`<>，。；、]+[\\/][^\s"'`<>，。；、]+\.(?:md|mdx|txt|json|ya?ml|toml|csv|docx?|xlsx?|xlsm|pptx?|pptm|pdf|odt|ods|odp|mov|mp4|mkv|avi|png|jpe?g|webp)\b/iu.test(String(query || ""));
}

function explicitAbsoluteLocalPaths(query) {
	const text = String(query || "");
	const values = [];
	const add = (raw) => {
		const value = String(raw || "").trim().replace(/^@/u, "");
		if (!/^[a-z]:[\\/]/iu.test(value)) return;
		values.push(path.win32.normalize(value));
	};
	for (const match of text.matchAll(/@?["'`]([a-z]:[\\/][^"'`\r\n]+)["'`]/giu)) add(match[1]);
	// Bare Windows file paths often run directly into Chinese prose without a
	// separating space ("a.png裁剪...", "raw.xlsx和D:/..."). Prefer an
	// extension-bounded match before the generic token fallback so prose never
	// becomes part of the authority path.
	for (const match of text.matchAll(/@?([a-z]:[\\/][^<>|?*"'`\r\n]*?\.[a-z0-9]{1,10})(?=$|[\s，。；、）)\]}]|\p{Script=Han})/giu)) add(match[1]);
	for (const match of text.matchAll(/@?([a-z]:[\\/][^<>|?*"'`\r\n]*?)(?=\s+(?:的|目录|文件|仓库|项目|当前|现有|并且|并|然后|随后|再|后|中|里|下|上)|[，。；、]|$)/giu)) {
		const candidate = String(match[1] || "");
		const driveRoots = candidate.match(/[a-z]:[\\/]/giu) || [];
		if (/\s/u.test(candidate) && driveRoots.length === 1) add(candidate);
	}
	for (const match of text.matchAll(/@?([a-z]:[\\/][^\s"'`<>|?*，。；、]+)/giu)) {
		const candidate = path.win32.normalize(match[1].replace(/[)\]}]+$/u, ""));
		if (values.some((value) => value === candidate || value.startsWith(candidate) || candidate.startsWith(value))) continue;
		add(candidate);
	}
	return [...new Set(values)];
}

function localArtifactReferenceIntent(query, explicitPaths = explicitAbsoluteLocalPaths(query)) {
	if (explicitPaths.length > 0) return true;
	const text = String(query || "");
	return /(?:这个|该|当前|现有|目标|上述|这张|这幅|这段|这份|桌面上(?:的)?|附件(?:中|里)?(?:的)?).{0,32}(?:文件|文档|表格|电子表格|演示文稿|图片|图像|照片|视频|\.(?:docx?|xlsx?|xlsm|pptx?|pptm|pdf|odt|ods|odp|csv|mov|mp4|mkv|avi|png|jpe?g|webp)\b)/iu.test(text);
}

function positiveLocalMutationText(query) {
	return String(query || "")
		.replace(/(?:禁止|不要|不得|不许|别|无需|不用|不必|不).{0,8}(?:再)?(?:做|进行)?(?:任何)?(?:修改|改动|更改|更新|写入|编辑|删除|移除)(?:.{0,16}(?:任何)?(?:文件|代码|源码|内容|本地状态))?/giu, " ")
		.replace(/(?:不要|无需|不用|不必|别).{0,8}(?:保存|另存(?:为)?|写入|写到|落盘|导出|输出(?:到|至)?)(?:.{0,12}(?:文件|本地|磁盘|副本|版本))?/giu, " ");
}

function localArtifactMutationIntent(query) {
	const text = String(query || "").trim();
	if (!text || wholeTaskReadonlyIntent(text)) return false;
	const explicitPaths = explicitAbsoluteLocalPaths(text);
	const localTarget = explicitPaths.length > 0 || localExecutionObjectIntent(text);
	if (!localTarget) return false;
	const positiveText = positiveLocalMutationText(text);
	const structuralMutation = /(?:删(?:除|掉|去|了)?|移除|清空|新建|创建|生成|制作|产出|复制|拷贝|移动|迁移|重命名|改名|另存(?:为)?|导出|输出(?:到|至)|转换|转(?:成|为)|合并|拆分|解压|压缩|delete\b|remove\b|create\b|generate\b|render\b|copy\b|duplicate\b|move\b|rename\b|save\s+as\b|export\b|convert\b|merge\b|split\b|extract\b|compress\b)/iu.test(positiveText);
	if (structuralMutation) return true;
	return localArtifactReferenceIntent(text, explicitPaths)
		&& /(?:修改|更新|改写|修订|替换|改(?:成|为|一下)|裁剪|截取|写入|追加|覆盖|保存|modify\b|update\b|edit\b|rewrite\b|replace\b|trim\b|crop\b|append\b|overwrite\b|save\b)/iu.test(positiveText);
}

function structuredArtifactTransformationIntent(query) {
	const text = String(query || "").trim();
	if (!/\.(?:docx?|xlsx?|xlsm|pptx?|pptm|pdf|odt|ods|odp)\b/iu.test(text)) return false;
	return /(?:删(?:除|掉|去|了)?|移除|清空|复制|拷贝|移动|迁移|重命名|改名|另存(?:为)?|导出|转换|合并|拆分|解压|压缩|delete\b|remove\b|copy\b|duplicate\b|move\b|rename\b|save\s+as\b|export\b|convert\b|merge\b|split\b|extract\b|compress\b)/iu.test(text);
}

function localArtifactWriteIntent(query) {
	const text = String(query || "").trim();
	if (!text || wholeTaskReadonlyIntent(text) || negatedWritingArtifactIntent(text)) return false;
	const positiveText = positiveLocalMutationText(text);
	const namedArtifact = /(?:\b(?:worklog|readme|changelog)\b|(?:^|[\\/\s"'`])[^\\/\s"'`<>]+\.(?:md|mdx|txt|rst|adoc|docx?|xlsx?|xlsm|pptx?|pptm|pdf|odt|ods|odp)(?:$|[\s"'`]))/iu;
	const artifact = /(?:方案|文档|说明|报告|总结|记录|日志|worklog|readme|changelog)/iu;
	const writeAction = /(?:写|撰写|起草|编写|改写|修改|修订|完善|整理|更新|追加|同步|新建|创建|另存)/iu;
	const strongPersist = /(?:写入|写到|保存(?:到|至|进)?|落盘|追加(?:到|进)?|同步(?:到|进)?)/iu;
	const localContext = /(?:本机|本地|仓库|项目|文件|目录|路径|现有|当前|这个|该)/iu;
	return (namedArtifact.test(positiveText) && writeAction.test(positiveText))
		|| (artifact.test(positiveText) && strongPersist.test(positiveText))
		|| (localContext.test(positiveText) && artifact.test(positiveText) && writeAction.test(positiveText));
}

function localPersistenceProhibitedIntent(query) {
	const text = String(query || "");
	const noPersist = /(?:(?:不要|无需|不用|不必|别).{0,8}|不)(?:保存|写入|写到|落盘).{0,12}(?:文件|本地|磁盘)|(?:do\s+not|don't|never).{0,8}(?:save|write|persist).{0,12}(?:files?|locally|to\s+disk)/iu.test(text);
	const chatDelivery = /(?:直接|只|仅).{0,12}(?:在)?(?:聊天|对话|回复|这里).{0,12}(?:给我|输出|展示|总结|回答|说明)|(?:直接|只|仅).{0,12}(?:给我|回复).{0,12}(?:文字|文本|内容)|\b(?:chat|reply)\s+only\b/iu.test(text);
	return noPersist && chatDelivery;
}

function localCommandExecutionIntent(query) {
	const text = positiveLocalMutationText(query);
	const action = /(?:运行|执行|跑(?:一下)?测试|编译|构建|安装|启动|调用|转换|转(?:成|为)|裁剪|压缩|解压|合并|拆分|处理|\brun\b|\bexecute\b|\bbuild\b|\bcompile\b|\binstall\b|\blaunch\b|\binvoke\b|\bconvert\b|\bprocess\b)/iu.test(text)
		|| /(?:测试|test)\s*(?:一下|这个|该|当前|本项目|项目|代码|模块|文件|功能|this\b|the\b|current\b|project\b|code\b|module\b|file\b|feature\b)/iu.test(text);
	const command = /(?:\bnpm\b|\bpnpm\b|\bbun\b|\bnode\b|\bpython\b|\bpytest\b|\bvitest\b|\bcargo\b|\bgo\s+test\b|\bbash\b|\bpowershell\b)/iu.test(text);
	return (localExecutionObjectIntent(text) && action) || command;
}

function taskEffects(query) {
	const text = String(query || "");
	const mutation = mutationIntent(text);
	const wholeTaskReadonly = wholeTaskReadonlyIntent(text);
	const confirmedReadonly = !mutation && confirmedReadonlyResponsibility(text);
	const persistenceProhibited = localPersistenceProhibitedIntent(text);
	const localArtifactWrite = !persistenceProhibited && localArtifactWriteIntent(text);
	const localFileMutationPossible = mutation || localArtifactWrite;
	const localCommandExecutionPossible = localCommandExecutionIntent(text);
	const explicitLocalPaths = explicitAbsoluteLocalPaths(text);
	const unresolvedLocalArtifact = localFileMutationPossible
		&& explicitLocalPaths.length === 0
		&& !workspaceRelativeArtifactLocatorIntent(text)
		&& localArtifactReferenceIntent(text, explicitLocalPaths);
	const wholeTaskMutationProhibited = wholeTaskReadonly || wholeTaskMutationProhibitedIntent(text);
	const localExecutionPossible = localFileMutationPossible || localCommandExecutionPossible;
	return {
		mutation,
		wholeTaskReadonly,
		wholeTaskMutationProhibited,
		confirmedReadonly,
		localArtifactWrite,
		localFileMutationPossible,
		localCommandExecutionPossible,
		localExecutionPossible,
		unresolvedLocalArtifact,
	};
}

function localExecutionAuthorityPaths(prompt, facts) {
	if (facts?.mutation !== true) return [];
	const text = String(prompt || "");
	const createSibling = /(?:新建|创建|另存(?:为)?|副本|复制|拷贝|导出|create\b|copy\b|duplicate\b|save\s+as\b|export\b)/iu.test(text);
	return [...new Set(explicitAbsoluteLocalPaths(text).map((filePath) => {
		const extension = path.win32.extname(filePath);
		return extension && createSibling ? path.win32.dirname(filePath) : filePath;
	}))];
}

function profileKeywordMatches(query, keyword) {
	if (lower(keyword) === "agent") return /(?:^|[^a-z0-9])agent(?:$|[^a-z0-9])/i.test(query);
	return query.includes(lower(keyword));
}

function dataAcquisitionIntent(query) {
	return /(?:数据源|开放数据|比较.{0,8}数据源|采集.{0,12}数据|数据.{0,12}(?:采集|获取|导入)|获取.{0,12}数据|下载.{0,12}(?:数据|csv|excel)|导入.{0,12}(?:数据|csv|excel|dataset)|接入.{0,12}(?:数据|api|feed|dataset)|定期.{0,12}(?:获取|采集|更新).{0,12}数据|data\s+source|data\s+acquisition|ingest(?:ion)?|\betl\b)/i.test(query);
}

const METADATA_SCORE_THRESHOLD = 12;
const STRONG_DOMAIN_SCORE = 36;
const MENU_HINT_SCORE = 2;
const LOW_INFORMATION_METADATA_SIGNALS = new Set([
	"a:agent", "a:agents", "a:api", "a:code", "a:coding", "a:csv", "a:data", "a:excel", "a:file", "a:files",
	"a:bug", "a:bugs", "a:fix", "a:fixes", "a:json", "a:model", "a:models", "a:next", "a:one", "a:pipeline", "a:prompt", "a:read", "a:search", "a:server", "a:skill", "a:skills", "a:test", "a:testing", "a:tool", "a:tools",
]);

// These are language-level equivalences, not Skill routes. They let rich
// canonical metadata stay authoritative when a user and an upstream Skill use
// different common wording for the same responsibility.
const QUERY_SEMANTIC_EQUIVALENTS = [
	{ pattern: /基本面/iu, terms: ["fundamental", "fundamentals", "financial", "statements", "business", "valuation"] },
	{ pattern: /(?:回归测试|回归保护|防止.{0,12}(?:复发|再次出现)|重复出现.{0,12}(?:bug|缺陷|问题))/iu, terms: ["regression", "testing", "repeated", "recurrence"] },
	{ pattern: /(?:(?:创建|新建|隔离).{0,16}worktree|worktree.{0,16}(?:创建|新建|隔离))/iu, terms: ["starting", "feature", "worktree", "isolated", "checkout"] },
	{ pattern: /(?:(?:收尾|完成|合并|清理).{0,16}worktree|worktree.{0,16}(?:收尾|完成|合并|清理))/iu, terms: ["complete", "branch", "worktree", "integration", "cleanup"] },
	{ pattern: /(?:数据库|schema|data).{0,16}(?:迁移|migration|backfill|回填)|(?:迁移|migration|backfill|回填).{0,16}(?:数据库|schema|data)/iu, terms: ["migration", "backfill", "rollout", "expand-contract", "zero-downtime"] },
	{ pattern: /(?:复杂|多个|多种).{0,20}(?:前端|ui).{0,28}(?:组合|协调|编排|资源|库|系统)|(?:前端|ui).{0,28}(?:多个|多种).{0,20}(?:库|skill|资源|系统)/iu, terms: ["orchestration", "multiple", "libraries", "visual-authority", "primitive-conflict"] },
	{ pattern: /(?:量化|因子|回测)/iu, terms: ["quantitative", "quant", "factor", "multi-factor", "walk-forward", "strategy", "optimization"] },
	{ pattern: /(?:获取|采集|抓取|下载|导入|接入).{0,12}数据|数据.{0,12}(?:获取|采集|抓取|下载|导入|接入)/iu, terms: ["data", "acquisition", "ingest"] },
	{ pattern: /(?:季度|季报|年报).{0,8}(?:财报|业绩)|(?:财报|业绩).{0,8}(?:季度|季报|年报)/iu, terms: ["earnings", "quarterly", "results", "guidance", "beat", "miss", "preview", "writeup"] },
	{ pattern: /(?:评估|评测|评价).{0,20}(?:agent|智能体|prompt|模型|工具)/iu, terms: ["evaluate", "evaluation", "benchmark", "controlled", "rubric", "grader", "behavior", "comparison"] },
	{ pattern: /(?:上线前|发布前|部署前|生产审计)/iu, terms: ["production", "readiness", "release", "audit"] },
	{ pattern: /(?:整理|盘点|管理|瘦身|精简).{0,24}(?:skill|技能)|(?:skill|技能).{0,24}(?:整理|盘点|管理|瘦身|精简)/iu, terms: ["organize", "inventory", "stocktake", "skills"] },
	{ pattern: /(?:有没有|是否有|找|查找|寻找|搜索|比较).{0,20}(?:现成|已有|可用|合适)?\s*(?:skill|技能)|(?:skill|技能).{0,20}(?:有没有|是否有|找|查找|寻找|搜索|比较|现成|已有|可用|合适)/iu, terms: ["discovery", "existing", "candidate", "candidates", "compare", "local", "library", "upstream"] },
	{ pattern: /机器学习|\bml\b|machine[- ]?learning/iu, terms: ["machine", "learning", "training", "serving", "deployment", "monitoring", "drift", "model"] },
	{ pattern: /深度研究|deep\s+research/iu, terms: ["deep", "research", "multi-source", "cited"] },
	{ pattern: /多来源|多源|证据|multi[- ]?source|evidence/iu, terms: ["multi-source", "evidence", "source", "corroboration"] },
	{ pattern: /(?:loop(?:ing)?|stuck|stalled|循环|卡住|停滞)/iu, terms: ["loops", "stalled", "progress"] },
	{ pattern: /(?:根因未知|未知根因|偶发|间歇|跨进程|跨组件|跨模块|flaky|intermittent|unknown\s+root\s+cause|cross[- ]component)/iu, terms: ["diagnosis", "root-cause", "unknown", "flaky", "intermittent", "cross-component", "hypothesis", "divergence"] },
	{ pattern: /(?:市场进入|市场规模|商业风险|商业尽调|投资人尽调|基金尽调|vendor\s*选择|供应商选择)/iu, terms: ["market", "sizing", "entry", "business", "commercial", "diligence", "vendor", "technology", "selection", "implications"] },
	{ pattern: /(?:扩展阅读|阅读扩展|论文消歧|文献消歧|引用邻域|引文邻域|引用谱系)/iu, terms: ["paper", "triage", "expanding", "reading-list", "expansion", "citation", "neighborhood", "disambiguation", "lineage", "tracing"] },
	{ pattern: /(?:全文中英对照|中英对照读|全文阅读|完整阅读.{0,16}(?:论文|paper)|图表感知(?:阅读|读论文)?)/iu, terms: ["full-paper", "chinese-english", "figure", "table", "aware", "reader", "reading", "translation", "anchors"] },
	{ pattern: /(?:竞品分析|竞品比较|竞争格局|竞争对手)/iu, terms: ["competitive", "competitor", "compare", "benchmark", "white-space", "decision", "analysis"] },
	{ pattern: /(?:查|找|搜|检索|搜索|扩展|引用|引文).{0,40}(?:论文|文献)|(?:论文|文献).{0,40}(?:检索|搜索|查找|扩展|引用|引文)/iu, terms: ["academic", "literature", "paper", "search", "citation", "citations"] },
	{ pattern: /(?:生成|创建|制作|绘制|修改|编辑|变换|处理).{0,20}(?:图片|图像|照片|插画)|(?:图片|图像|照片|插画).{0,20}(?:生成|创建|制作|绘制|修改|编辑|变换|处理)/iu, terms: ["image", "raster", "visual", "generate", "edit", "transform"] },
	{ pattern: /专利/iu, terms: ["patent", "invention", "claims", "specification"] },
	{ pattern: /oauth|认证|鉴权|授权|权限|安全边界|secret|credential|csrf|cors|webhook|支付|(?:auth(?:entication|orization)?|security|权限|认证|鉴权|授权).{0,20}(?:session|tenant)|(?:session|tenant).{0,20}(?:auth(?:entication|orization)?|security|权限|认证|鉴权|授权)/iu, terms: ["oauth", "authentication", "authorization", "privilege", "security", "payment", "payments", "secret", "secrets", "credentials", "session", "tenant", "boundary", "trust", "sensitive", "risk"] },
	{ pattern: /\bmcp\b|model\s+context\s+protocol/iu, terms: ["mcp", "service", "boundary", "contract", "transport"] },
	{ pattern: /前端|frontend|react|next\.?js/iu, terms: ["frontend", "product", "ui", "interaction", "state"] },
];

function metadataSignals(value) {
	const signals = new Set();
	for (const term of lower(value).match(/[a-z][a-z0-9+.-]{2,}/gu) || []) {
		signals.add(`a:${term}`);
		for (const part of term.split(/[.+-]/u)) {
			if (part.length >= 3) signals.add(`a:${part}`);
		}
	}
	for (const segment of String(value || "").match(/\p{Script=Han}{2,}/gu) || []) {
		for (let size = 2; size <= Math.min(4, segment.length); size += 1) {
			for (let index = 0; index + size <= segment.length; index += 1) signals.add(`h${size}:${segment.slice(index, index + size)}`);
		}
	}
	return signals;
}

function queryMetadataSignals(prompt) {
	const semanticPrompt = semanticPromptText(prompt);
	const signals = metadataSignals(semanticPrompt);
	for (const equivalent of QUERY_SEMANTIC_EQUIVALENTS) {
		if (!equivalent.pattern.test(semanticPrompt)) continue;
		for (const signal of metadataSignals(equivalent.terms.join(" "))) signals.add(signal);
	}
	return signals;
}

function buildMetadataEvidence(sources) {
	const frequency = new Map();
	const bySkill = new Map();
	const negativeBySkill = new Map();
	for (const skill of sources.skillWinners.values()) {
		const signals = metadataSignals(`${skill.name} ${skill.description}`);
		bySkill.set(lower(skill.name), signals);
		const negativeSignals = new Set();
		for (const sentence of String(skill.description || "").split(/(?<=[.!?;。；])\s*/u)) {
			if (!/(?:\bdo not\b|\bdon't\b|\bdoes not\b|\bnot for\b|\bnever\b|\bavoid\b|禁止|不要|不适用|不用于)/iu.test(sentence)) continue;
			const negativeClause = sentence.split(/\bwhen\s+no\b|\bunless\b|\bexcept\s+when\b|\bwhich\s+belongs\b|除非|但当|而当/iu)[0];
			for (const signal of metadataSignals(negativeClause)) negativeSignals.add(signal);
		}
		negativeBySkill.set(lower(skill.name), negativeSignals);
		for (const signal of signals) frequency.set(signal, (frequency.get(signal) || 0) + 1);
	}
	return { frequency, bySkill, negativeBySkill };
}

function metadataSignalWeight(signal, frequency) {
	if (LOW_INFORMATION_METADATA_SIGNALS.has(signal)) return 0;
	const count = frequency.get(signal) || 0;
	if (!count) return 0;
	if (signal.startsWith("a:")) return count === 1 ? 18 : count <= 3 ? 12 : count <= 8 ? 6 : 1;
	const size = Number(signal[1]) || 2;
	if (size === 4) return count === 1 ? 14 : count <= 3 ? 9 : count <= 8 ? 4 : 0;
	if (size === 3) return count === 1 ? 9 : count <= 3 ? 6 : count <= 8 ? 2 : 0;
	return count === 1 ? 5 : count <= 3 ? 3 : 0;
}

function metadataSemanticScore(skill, prompt, evidence, querySignals) {
	let score = keywordMatchesQuery(lower(prompt), lower(skill.name)) ? 100 : 0;
	let negativeWeight = 0;
	let positiveWeight = 0;
	const skillSignals = evidence.bySkill.get(lower(skill.name)) || new Set();
	const negativeSignals = evidence.negativeBySkill.get(lower(skill.name)) || new Set();
	for (const signal of querySignals) {
		if (!skillSignals.has(signal)) continue;
		const weight = metadataSignalWeight(signal, evidence.frequency);
		if (negativeSignals.has(signal)) negativeWeight += weight;
		else positiveWeight += weight;
		score += negativeSignals.has(signal) ? -2 * weight : weight;
	}
	if (negativeWeight >= METADATA_SCORE_THRESHOLD && negativeWeight >= positiveWeight) return Math.min(score, 0);
	return score;
}

function directMetadataSemanticScore(skill, prompt, evidence) {
	const querySignals = metadataSignals(semanticPromptText(prompt));
	const skillSignals = evidence.bySkill.get(lower(skill.name)) || new Set();
	const negativeSignals = evidence.negativeBySkill.get(lower(skill.name)) || new Set();
	let score = 0;
	let negativeWeight = 0;
	let positiveWeight = 0;
	for (const signal of querySignals) {
		if (!skillSignals.has(signal)) continue;
		const weight = metadataSignalWeight(signal, evidence.frequency);
		if (negativeSignals.has(signal)) negativeWeight += weight;
		else positiveWeight += weight;
		score += negativeSignals.has(signal) ? -2 * weight : weight;
	}
	if (negativeWeight >= METADATA_SCORE_THRESHOLD && negativeWeight >= positiveWeight) return Math.min(score, 0);
	return score;
}

function suppliedMaterialOnlyIntent(query) {
	const supplied = /(?:我|用户)?(?:提供|上传|附上|贴出|给你).{0,24}(?:财报|报告|文件|材料|数据|内容)|(?:这份|以下|下列|附件).{0,20}(?:财报|报告|文件|材料|数据|内容)/iu.test(query);
	const lookup = /(?:联网|网上|查询|查找|获取|拉取|最新|当前|现在多少钱|股价|行情|持仓|账户|look\s+up|fetch|latest|current|quote|stock\s+price)/iu.test(query);
	return supplied && !lookup;
}

function pureExplanationIntent(query) {
	const explanation = /(?:是什么|什么意思|概念|原理|如何计算|怎么计算|怎么算|公式|what\s+is|what\s+does.{0,20}mean|explain|how.{0,20}works)/iu.test(query);
	const lookup = /(?:联网|网上|查询|查找|获取|拉取|最新|当前|现在多少钱|股价|行情|走势|持仓|账户|look\s+up|fetch|latest|current|quote|stock\s+price)/iu.test(query);
	return explanation && !lookup;
}

function nonSecuritiesBusinessResearchIntent(query) {
	const business = /(?:市场进入|市场规模|商业风险|商业尽调|投资人尽调|基金尽调|vendor\s*选择|供应商选择|market\s+entry|market\s+sizing|commercial\s+risk|vendor\s+selection)/iu.test(query);
	const clearlyNonSecuritiesResearch = /(?:深度研究|deep\s+research|竞品分析|竞争格局|competitive\s+analysis)/iu.test(query)
		&& /(?:agent|智能体|软件|产品|技术|technology|software|vendor|ai\s+coding)/iu.test(query);
	const securities = /(?:股票|证券|etf|上市公司|股价|行情|财报|估值|持仓|账户|基本面|技术分析|stock\s+price|quote|earnings|valuation|portfolio|ticker)/iu.test(query);
	return (business || clearlyNonSecuritiesResearch) && !securities;
}

function providerFamilyEligible(skill, prompt) {
	const name = lower(skill.name);
	if (name !== "longbridge" && !name.startsWith("longbridge-")) return true;
	const query = lower(prompt);
	const familyIntent = /\blongbridge\b|长桥|股票|证券|股价|行情|盘口|持仓|投资组合|基本面|财报|业绩|估值|技术分析|量化|回测|期权|quote|stock\s+price|portfolio|fundamentals?|earnings|valuation|\b[A-Z]{3,6}(?:\.(?:US|HK|SH|SZ|SG))?\b/u.test(String(prompt || ""));
	return familyIntent && !suppliedMaterialOnlyIntent(query) && !pureExplanationIntent(query) && !nonSecuritiesBusinessResearchIntent(query);
}

function longbridgePlatformDevelopmentIntent(query) {
	const text = String(query || "");
	const namedFamily = /\blongbridge\b|长桥/iu.test(text);
	const platformSurface = /\b(?:cli|mcp|sdk|api)\b|开发者平台|开发平台/iu.test(text);
	const engineeringAction = /(?:开发|实现|集成|接入|调试|修复|扩展|开发者|develop|implement|integrat|debug|fix|extend)/iu.test(text);
	return namedFamily && platformSurface && engineeringAction;
}

function descriptionExcludesEngineeringMutation(skill) {
	return /(?:\bdo not use\b|\bnot for\b|\bnever use\b|不用于|不适用|不要用于).{0,140}(?:实现功能|开发功能|修复代码|代码实现|工程实现|调试|重构|code\s+implementation|coding|debug|refactor)/iu.test(String(skill?.description || ""));
}

function scoreSkill(skill, prompt, menu, metadataEvidence, querySignals, menuEvidence) {
	if (!providerFamilyEligible(skill, prompt)) return 0;
	const query = lower(prompt);
	const explicitNameStem = skill.explicitOnly ? (lower(skill.name).split(/[-_.]/u).find((part) => part.length >= 3) || "") : "";
	const namedExplicitMethod = explicitNameStem
		&& !LOW_INFORMATION_METADATA_SIGNALS.has(`a:${explicitNameStem}`)
		&& keywordMatchesQuery(query, explicitNameStem);
	if (descriptionOwnsWritingArtifact(skill) && negatedWritingArtifactIntent(query)) return 0;
	if (descriptionOwnsWritingArtifact(skill) && structuredArtifactTransformationIntent(query)) return 0;
	if (engineeringMutationIntent(query) && descriptionExcludesEngineeringMutation(skill) && !namedExplicitMethod) return 0;
	let semantic = metadataSemanticScore(skill, prompt, metadataEvidence, querySignals) + responsibilityAlignmentScore(skill, prompt);
	if (skill.explicitOnly) {
		if (!namedExplicitMethod && semantic < STRONG_DOMAIN_SCORE) return 0;
		if (namedExplicitMethod) semantic = Math.max(semantic, STRONG_DOMAIN_SCORE);
	}
	let menuHint = 0;
	for (const rule of menu?.rules || []) {
		if (!rule.skills.includes(lower(skill.name))) continue;
		if (ruleMatchesPrompt(query, rule, menuEvidence)) menuHint = MENU_HINT_SCORE;
	}
	if (semantic < METADATA_SCORE_THRESHOLD && menuHint === 0) return 0;
	return semantic + menuHint;
}

function explicitContinuationIntent(query) {
	const text = String(query || "");
	return /(?:持续推进(?:直到|到)?完成|跨会话恢复|后台继续|继续推进直到完成|继续.{0,20}直到.{0,12}(?:完成|做完)|(?:不要|别|不得|不许).{0,12}中途.{0,8}(?:停|停止|结束)|(?:做完|完成).{0,16}再(?:停|停止|结束)|一轮.{0,12}(?:做不完|没做完).{0,16}继续.{0,16}(?:直到|直至).{0,12}(?:完成|做完)|一直.{0,12}(?:做|推进|继续).{0,24}(?:完成|做完).{0,12}再?(?:停|停止|结束)|把.{0,16}(?:剩下|余下|全部|所有).{0,16}(?:做完|完成)|continue\s+until\s+done|keep\s+going\s+until\s+complete|do\s+not\s+stop\s+until\s+(?:done|complete)|finish\s+(?:everything|the\s+rest)\s+before\s+stopping)/iu.test(text);
}

function browserExecutionIntent(query) {
	const text = String(query || "");
	return /(?:\b(?:use|open|launch|run)\s+(?:the\s+)?browser\b|\bbrowser\b.{0,32}(?:login|click|navigate|screenshot|test|verify|operate)|浏览器.{0,24}(?:验证|测试|操作|登录|点击|点开|导航|跳转|截图|提交|上传|下载)|(?:用|打开|启动).{0,8}浏览器|(?:网页|网站|后台页面|页面)(?:里|中|上|内).{0,32}(?:点击|点开|打开|登录|输入|填写|导航|跳转|截图|提交|上传|下载|操作)|(?:点击|点开|登录|输入|填写|导航|截图|提交|上传|下载|操作).{0,24}(?:网页|网站|后台页面|页面))/iu.test(text);
}

function webAcquisitionIntent(query) {
	const text = String(query || "");
	const localSearch = /(?:\bsearch\s+(?:the\s+)?local\s+files?\b|\bsearch\s+(?:this|the\s+current)\s+(?:repo(?:sitory)?|project)\b|(?:搜索|检索|查找|查询).{0,12}(?:本地|本机|当前仓库|当前项目).{0,12}(?:文件|代码|内容)?)/iu.test(text);
	const explicitExternal = /(?:联网|上网|网上|互联网|网页|github|新闻|在线|\bweb\b|\binternet\b|\bonline\b)/iu.test(text);
	if (localSearch && !explicitExternal) return false;
	if (/(?:联网|上网|网上|互联网|网页|github|新闻|最新|深度研究|调研|竞品|尽调|竞争格局|\bweb\b|\bsearch\b|\bresearch\b)/iu.test(text)) return true;
	return /(?:搜索|检索|查询|查找|搜集|收集|核验|验证|找).{0,20}(?:资料|来源|证据)|(?:资料|来源|证据).{0,20}(?:搜索|检索|查询|查找|搜集|收集|核验|验证)/iu.test(text);
}

function longProfileIntent(query) {
	const text = String(query || "").replace(/\btodo\s+comments?\b/giu, " ");
	return explicitContinuationIntent(text) || /(?:长期|长任务|持续|\bgoal\b|\btodo\b|计划|milestone|background)/iu.test(text);
}

function chooseProfiles(prompt) {
	const query = lower(prompt);
	const semanticQuery = lower(semanticPromptText(prompt));
	const prohibited = explicitCapabilityProhibitions(query);
	const matched = PROFILE_RULES.filter((rule) =>
		rule.profile === "web"
			? webAcquisitionIntent(semanticQuery)
			: rule.profile === "long"
				? longProfileIntent(semanticQuery)
			: rule.profile === "data"
			? dataAcquisitionIntent(semanticQuery)
			: rule.profile === "computer"
				? computerExecutionIntent(semanticQuery)
				: rule.profile === "browser"
					? browserExecutionIntent(semanticQuery)
					: rule.keywords.some((keyword) => profileKeywordMatches(semanticQuery, keyword)),
	);
	let profiles = matched.map((rule) => rule.profile);
	if (explicitContinuationIntent(semanticQuery) && !profiles.includes("long")) profiles.push("long");
	if (localFreshnessOnlyIntent(query) && requiredExecutionSurfaces(query).length === 0) profiles = profiles.filter((profile) => profile !== "web");
	if (prohibited.web) profiles = profiles.filter((profile) => profile !== "web");
	if (prohibited.browser) profiles = profiles.filter((profile) => profile !== "browser");
	if (prohibited.computer) profiles = profiles.filter((profile) => profile !== "computer");
	if (prohibited.agent) profiles = profiles.filter((profile) => profile !== "agent");
	const effects = taskEffects(query);
	const hasLocalExecutionIntent = effects.localExecutionPossible;
	if (profiles.includes("readonly") && !hasLocalExecutionIntent) {
		profiles = ["readonly", ...profiles.filter((profile) => profile !== "readonly" && profile !== "lean")];
	} else if (profiles.includes("readonly") && hasLocalExecutionIntent && !wholeTaskReadonlyIntent(query)) {
		// A local scout/review modifier must not remove the parent mutation
		// surface.  Whole-task readonly remains a hard route constraint.
		profiles = profiles.filter((profile) => profile !== "readonly");
	}
	if (profiles.includes("browser") || profiles.includes("computer")) {
		const interaction = ["browser", "computer"].filter((profile) => profiles.includes(profile));
		profiles = [...interaction, ...profiles.filter((profile) => !interaction.includes(profile))];
	}
	if (profiles.includes("agent") && profiles.includes("long")) {
		profiles = ["long", "agent", ...profiles.filter((profile) => profile !== "long" && profile !== "agent")];
	}
	profiles = [...new Set(profiles)];
	if (hasLocalExecutionIntent && !profiles.includes("lean")) profiles.push("lean");
	if (!profiles.length) profiles = ["lean"];
	return profiles;
}

function explicitCapabilityProhibitions(query) {
	const text = String(query || "");
	return {
		web: /(?:不要|不许|禁止|别|无需|不用)(?:再)?(?:(?:用|使用|调用|访问)?\s*(?:web(?:[_\s-]?search|\s*access)?|internet)|联网|上网|访问网络|网络搜索)|不联网|(?:do\s+not|don't|never|without)\s+(?:use|access|search|browse)?\s*(?:the\s+)?(?:web(?:[_\s-]?search)?|internet|online)/iu.test(text),
		browser: /(?:不要|不许|禁止|别|无需|不用)(?:再)?(?:用|使用|打开|启动|调用)?\s*(?:浏览器|browser)|(?:do\s+not|don't|never|without)\s+(?:use|open|launch|run)?\s*(?:the\s+)?browser/iu.test(text),
		computer: /(?:不要|不许|禁止|别|无需|不用)(?:再)?(?:用|使用|操作|控制|调用)?\s*(?:电脑|桌面|computer(?:[- ]?use)?|desktop(?:\s+automation)?)|(?:do\s+not|don't|never|without)\s+(?:use|operate|control|automate)?\s*(?:the\s+)?(?:computer|desktop)/iu.test(text),
		agent: /(?:不要|不许|禁止|别|无需|不用)(?:再)?(?:用|使用|启动|调用)?\s*(?:agent|subagent|agent\s*swarm|子代理|智能体)|(?:do\s+not|don't|never|without)\s+(?:use|call|start|spawn)?\s*(?:an?\s+)?(?:agent|subagent|agent\s*swarm)/iu.test(text),
	};
}

function computerExecutionIntent(query) {
	const text = String(query || "");
	const chinese = /(?:用|使用|去|到|打开|启动|操作|点击|输入|控制|查看|看看|检查|截图).{0,24}(?:电脑|桌面|Windows\s*设置|设置窗口|计算器|记事本|文件资源管理器|本机应用|原生应用|桌面应用|窗口)|(?:电脑|桌面|Windows\s*设置|设置窗口|计算器|记事本|文件资源管理器|本机应用|原生应用|桌面应用|窗口).{0,24}(?:打开|启动|操作|点击|输入|控制|查看|看看|检查|截图)/iu.test(text);
	const english = /\b(?:computer[- ]?use|desktop\s+automation)\b|\b(?:use|open|launch|operate|click|type|control|inspect|screenshot)\b.{0,32}\b(?:computer|desktop|windows\s+settings|calculator|notepad|file\s+explorer|native\s+app|desktop\s+app|window)\b/iu.test(text);
	return chinese || english;
}

function localFreshnessOnlyIntent(query) {
	const text = String(query || "");
	return /(?:最新|当前|现有|latest|current)/iu.test(text)
		&& /(?:本机|本地|当前仓库|当前项目|这个仓库|这个项目|该仓库|该项目|\blocal\b|\bthis\s+(?:repo(?:sitory)?|project)\b)/iu.test(text);
}

function explicitSkillName(prompt) {
	const match = String(prompt || "").match(/(?:\/one\s+skill|skill\s*:)\s*([\w.-]+)/i);
	return match?.[1]?.toLowerCase() || null;
}

function stripPromptSkillDirective(prompt) {
	return String(prompt || "")
		.replace(/(?:\/one\s+skill\s*:?[ \t]*|skill\s*:\s*)[\w.-]+/giu, " ")
		.replace(/[ \t]{2,}/gu, " ")
		.trim();
}

function primaryGeneralDocumentWritingIntent(query) {
	const text = String(query || "");
	if (structuredArtifactTransformationIntent(text)) return false;
	if (!/(?:方案|文档|说明|报告|总结|worklog|readme)/iu.test(text)) return false;
	if (primaryWritingArtifactIntent(text)) return true;
	if (!localArtifactWriteIntent(text)) return false;
	return !/(?:修复|重构|实现|开发|新增|添加|修改).{0,20}(?:代码|功能|模块|系统|服务|接口|页面|程序|机制|应用)/iu.test(text);
}

function primaryCompletionVerificationIntent(query) {
	const text = String(query || "");
	const verification = /(?:完成验证|验收|完成证据|验证.{0,24}(?:真实|real).{0,16}(?:caller|调用方)|verify.{0,24}(?:complete|fixed|passing|ready)|(?:complete|fixed|passing|ready).{0,24}verif)/iu.test(text);
	const completedChange = /(?:(?:实现|修改|修复|变更|开发|工作).{0,16}(?:已经|已|完成|做完)|(?:already|implementation|change|fix).{0,24}(?:complete|done|finished))/iu.test(text);
	return verification && completedChange;
}

function strongResponsibilityOwner(skill, query) {
	if (primaryAcademicSearchIntent(query)) return descriptionOwnsAcademicSearch(skill);
	if (primaryUiOrchestrationIntent(query)) return descriptionOwnsUiOrchestration(skill);
	if (primaryPosterIntent(query)) return descriptionOwnsPoster(skill);
	if (genericRasterImageIntent(query)) return descriptionOwnsGenericRasterImages(skill);
	if (primaryGeneralDocumentWritingIntent(query)) return descriptionOwnsWritingArtifact(skill) && descriptionOwnsGeneralDocumentWriting(skill);
	if (primaryCompletionVerificationIntent(query)) return descriptionOwnsCompletionVerification(skill);
	return false;
}

function promoteLongbridgeSpecialist(scored, query) {
	if (scored[0]?.skill?.name !== "longbridge") return scored;
	const namedSpecialistIndex = scored.findIndex(({ skill }) => {
		const name = lower(skill.name);
		if (!name.startsWith("longbridge-")) return false;
		const suffixTokens = name.slice("longbridge-".length).split("-").filter((token) => token.length >= 4);
		return suffixTokens.some((token) => keywordMatchesQuery(query, token));
	});
	const metadataSpecialist = scored
		.map((row, index) => ({ ...row, index }))
		.filter(({ skill, score, directScore, index }) => index > 0 && lower(skill.name).startsWith("longbridge-") && score >= METADATA_SCORE_THRESHOLD && directScore >= 5)
		.sort((left, right) => right.directScore - left.directScore || right.score - left.score || left.skill.name.localeCompare(right.skill.name))[0];
	const specialistIndex = namedSpecialistIndex > 0 ? namedSpecialistIndex : metadataSpecialist?.index ?? -1;
	if (specialistIndex <= 0) return scored;
	const promoted = scored[specialistIndex];
	return [promoted, ...scored.slice(0, specialistIndex), ...scored.slice(specialistIndex + 1)];
}

function chooseSkills(sources, prompt, profiles, menu, { explicitSkill, requiredSkill, responsibilityRole, allowPromptSkillDirective = true } = {}) {
	const scoringPrompt = allowPromptSkillDirective ? String(prompt || "") : stripPromptSkillDirective(prompt);
	const query = lower(scoringPrompt);
	const menuEvidence = buildMenuEvidence(menu);
	const metadataEvidence = buildMetadataEvidence(sources);
	const querySignals = queryMetadataSignals(scoringPrompt);
	const scored = [...sources.skillWinners.values()]
		.map((skill) => ({
			skill,
			score: scoreSkill(skill, scoringPrompt, menu, metadataEvidence, querySignals, menuEvidence),
			directScore: directMetadataSemanticScore(skill, scoringPrompt, metadataEvidence),
		}))
		.filter(({ score }) => score > 0)
		.sort((left, right) => right.score - left.score || right.directScore - left.directScore || left.skill.name.localeCompare(right.skill.name));
	const ranked = promoteLongbridgeSpecialist(scored, query);
	const explicitMethodCandidate = ranked.find(({ skill }) => skill.explicitOnly)?.skill;
	const responsibilityCandidates = [...sources.skillWinners.values()]
		.filter((skill) => !skill.explicitOnly && providerFamilyEligible(skill, scoringPrompt) && strongResponsibilityOwner(skill, query))
		.map((skill) => ({ skill, score: scoreSkill(skill, scoringPrompt, menu, metadataEvidence, querySignals, menuEvidence) }))
		.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
	const explicit = lower(explicitSkill || (allowPromptSkillDirective ? explicitSkillName(prompt) : ""));
	if (explicit) {
		const selected = sources.skillWinners.get(explicit);
		if (!selected) throw new Error(`Requested Pi-One Skill is not an active winner: ${explicit}`);
		return { immediate: [readWinningSkillMetadata(selected)], deferred: [] };
	}
	const inherited = lower(requiredSkill);
	if (inherited) {
		const selected = sources.skillWinners.get(inherited);
		if (!selected) throw new Error(`Requested Pi-One Skill is not an active winner: ${inherited}`);
		return { immediate: [readWinningSkillMetadata(selected)], deferred: [] };
	}
	const responsibilityCandidate = responsibilityCandidates[0];
	const projectCandidate = ranked.find(({ skill }) => skill.rootKind === "project");
	const maintainable = sources.skillWinners.get("maintainable-code-craft");
	const engineeringReview = profiles.includes("readonly") && /(?:代码|code|diff|函数|模块|实现|refactor|repository|repo)/i.test(scoringPrompt);
	const reviewBaseline = engineeringReview && maintainable && !maintainable.explicitOnly ? maintainable : null;
	const verification = sources.skillWinners.get("verification-loop");
	const rolePreferred = responsibilityRole === "review" && (profiles.includes("lean") || profiles.includes("readonly")) && verification && !verification.explicitOnly
		? verification
		: responsibilityRole === "coder" && profiles.includes("lean") && maintainable && !maintainable.explicitOnly
			? maintainable
			: null;
	const defaultEngineering = engineeringMutationIntent(query) && maintainable && !maintainable.explicitOnly ? maintainable : null;
	const providerBaseCandidate = longbridgePlatformDevelopmentIntent(scoringPrompt) ? sources.skillWinners.get("longbridge") : null;
	const providerSpecialistCandidate = lower(ranked[0]?.skill?.name).startsWith("longbridge-") ? ranked[0].skill : null;
	const directDomainCandidate = ranked
		.filter(({ skill, directScore }) => skill.name !== "maintainable-code-craft" && !lower(skill.name).startsWith("longbridge") && directScore >= 18)
		.sort((left, right) => right.directScore - left.directScore || right.score - left.score || left.skill.name.localeCompare(right.skill.name))[0]?.skill;
	const strongDomainCandidate = ranked.find(({ score }) => score >= STRONG_DOMAIN_SCORE)?.skill;
	const selected = explicitMethodCandidate || responsibilityCandidate?.skill || projectCandidate?.skill || providerBaseCandidate || providerSpecialistCandidate || directDomainCandidate || strongDomainCandidate || reviewBaseline || rolePreferred || defaultEngineering || ranked[0]?.skill;
	const immediate = selected ? [readWinningSkillMetadata(selected)] : [];
	const immediateNames = new Set(immediate.map((skill) => skill.name.toLowerCase()));
	const deferred = ranked
		.filter(({ skill, score }) => score >= STRONG_DOMAIN_SCORE && !immediateNames.has(skill.name.toLowerCase()))
		.slice(0, 3)
		.map(({ skill }) => ({
		name: skill.name,
		path: skill.path,
		trigger: `Use when the ${profiles.join("+")} route needs ${skill.name}.`,
		}));
	return { immediate, deferred };
}

function routeReason(prompt, profiles) {
	const matched = profiles.flatMap((profile) => PROFILE_RULES.find((rule) => rule.profile === profile)?.keywords || []).filter((keyword) =>
		lower(prompt).includes(lower(keyword)),
	);
	return matched.length ? [...new Set(matched)] : ["default-minimal-profile"];
}

function episodicMemoryIntent(query) {
	const text = String(query || "");
	return /(?:继续|接着|恢复).{0,24}(?:上次|之前|先前|此前|前一个|上个|另一个).{0,16}(?:会话|聊天|讨论|工作|方案|任务|内容)?|(?:上次|之前|先前|此前|前一个|上个|另一个).{0,20}(?:会话|聊天|讨论|说过|提到|做过|写过|方案|工作|任务|结果|记录)|(?:还记得|记得我|你记得|回忆|找回|回看).{0,28}(?:之前|上次|以前|先前|会话|聊天|讨论)|(?:跨会话|历史会话|会话历史).{0,24}(?:搜索|检索|查找|找|恢复|回忆|记录|内容)?|\b(?:recall|remember)\b.{0,48}\b(?:previous|prior|earlier|last|session|conversation|chat)\b|\b(?:continue|resume|recover)\b.{0,36}\b(?:previous|prior|earlier|last)\b.{0,20}\b(?:session|conversation|chat|work|task)\b|\b(?:previous|prior|earlier|last)\b.{0,20}\b(?:session|conversation|chat)\b/iu.test(text);
}

function memoryRecallLevel(query) {
	const text = String(query || "");
	const durableMemoryIntent = /(?:你还记得|你记得|还记得).{0,24}(?:我|我的|我们|这个项目)|(?:我的|我之前的|我们之前的).{0,20}(?:偏好|决定|约定|记忆|习惯)|\b(?:what|which)\b.{0,24}\b(?:remember|memory|memories)\b.{0,24}\b(?:me|my|our)\b|\b(?:my|our|saved)\b.{0,16}\b(?:preference|decision|memory|memories|convention)\b/iu.test(text);
	if (!episodicMemoryIntent(text) && !durableMemoryIntent) return 0;
	return /(?:原话|原文|逐字|完整|具体|详细|准确|精确|来源|出处)|\b(?:exact|verbatim|full|complete|detail|detailed|source)\b/iu.test(text) ? 2 : 1;
}

function pinnedMemoryManageIntent(query) {
	const text = String(query || "");
	const delivery = /(?:按需|需要时|用到时|需要的时候|不要|别).{0,20}(?:固定|常驻|每轮|每次).{0,16}(?:上下文|提示|prompt|记忆)|(?:按需记住|按需保存)|\b(?:on[- ]?demand|only\s+when\s+needed|do\s+not\s+pin|don't\s+pin)\b/iu.test(text)
		? "on_demand"
		: "pinned";
	const globalScopeMentioned = /(?:全局|所有项目|全部项目|跨项目|所有工作区|每个项目|以后所有项目)|\b(?:globally|across\s+(?:all\s+)?projects|all\s+projects|every\s+project)\b/iu.test(text);
	const globalScopeNegated = /(?:不要|别|无需|不用|不需要|仅|只).{0,12}(?:全局|所有项目|跨项目)|(?:全局|所有项目|跨项目).{0,12}(?:不要|不需要|禁用)|\b(?:not|don't|do\s+not|never|only)\b.{0,12}\b(?:globally|across\s+(?:all\s+)?projects|all\s+projects)\b/iu.test(text);
	const userScopeAuthorized = globalScopeMentioned && !globalScopeNegated;
	const privilegedRuleAuthorized = /(?:以后|今后|从现在起|总是|始终|自动|默认|必须|允许|禁止|无需|不用|不要|跳过|绕过).{0,48}(?:工具|权限|授权|审批|批准|确认|human\s*gate|promotion|安全|密钥|凭据|secret|credential|执行|运行|修改|写入|删除|身份|人格|角色|系统提示)|\b(?:always|never|automatically|by\s+default|must|allow|deny|skip|bypass|without\s+(?:asking|approval|confirmation)|from\s+now\s+on)\b.{0,56}\b(?:tool|permission|authorization|approval|confirmation|human\s+gate|promotion|security|secret|credential|execute|run|modify|write|delete|identity|persona|system\s+prompt)\b/iu.test(text);
	const writeAuthorityTier = privilegedRuleAuthorized ? "W3" : "W2";
	const localScopeRemember = /(?:只|仅).{0,10}(?:在)?(?:当前|本)(?:项目|工作区).{0,10}(?:记住|记下来|保存到记忆)|\b(?:only|just)\b.{0,12}\b(?:in|for)\s+(?:this|the\s+current)\s+(?:project|workspace)\b.{0,16}\bremember\b/iu.test(text);
	if (/(?:忘掉|忘记|移除|撤回|删除).{0,24}(?:记忆|记住的|你记得的)|(?:记忆|memory).{0,24}(?:forget|delete|remove|retract)|\bforget\b.{0,24}\b(?:memory|remembered)\b/iu.test(text)) {
		return { needed: true, operation: "forget", userScopeAuthorized, delivery, writeAuthorityTier: "W2" };
	}
	if (/(?:纠正|更正|修正|修改|更新|改掉).{0,24}(?:记忆|记住的|你记得的)|(?:记忆|memory).{0,24}(?:correct|update|change|revise)|\b(?:correct|update|change|revise)\b.{0,24}\b(?:memory|remembered)\b/iu.test(text)) {
		return { needed: true, operation: "correct", userScopeAuthorized, delivery, writeAuthorityTier };
	}
	if (/(?:查看|看看|列出|告诉我|检查).{0,24}(?:记忆|你记住|你记得|保存的记忆)|(?:你|现在).{0,8}(?:记住|记得).{0,8}(?:什么|哪些)|\b(?:show|list|inspect)\b.{0,24}\b(?:memory|memories|remembered)\b|\bwhat\b.{0,24}\b(?:remember|memory)\b/iu.test(text)) {
		return { needed: true, operation: "inspect", userScopeAuthorized, delivery, writeAuthorityTier: "W0" };
	}
	if (localScopeRemember) return { needed: true, operation: "remember", userScopeAuthorized: false, delivery, writeAuthorityTier };
	if (/(?:不要|别|无需|不用|不需要).{0,10}(?:记住|记下来|保存到记忆)|\b(?:don't|do\s+not|never)\s+remember\b/iu.test(text)) {
		return { needed: false, operation: null, userScopeAuthorized: false, writeAuthorityTier: "W0" };
	}
	if (/(?:请|帮我|以后|从现在起)?\s*(?:记住|记下来|记到记忆|保存到记忆)|(?:以后|今后).{0,12}(?:记得|记住)|\b(?:please\s+)?remember\s+(?:this|that|the\s+following|from\s+now\s+on|going\s+forward)\b|\bsave\b.{0,16}\b(?:to|in)\s+(?:your\s+)?memory\b/iu.test(text)) {
		return { needed: true, operation: "remember", userScopeAuthorized, delivery, writeAuthorityTier };
	}
	return { needed: false, operation: null, userScopeAuthorized: false, delivery: "pinned", writeAuthorityTier: "W0" };
}

function intentFacts(prompt, profiles) {
	const query = lower(prompt);
	const prohibited = explicitCapabilityProhibitions(query);
	const effects = taskEffects(query);
	const {
		mutation,
		wholeTaskReadonly,
		wholeTaskMutationProhibited,
		confirmedReadonly,
		localFileMutationPossible,
		localCommandExecutionPossible,
		localExecutionPossible,
		unresolvedLocalArtifact,
	} = effects;
	const memoryManage = pinnedMemoryManageIntent(query);
	const recallLevel = memoryManage.needed ? 0 : memoryRecallLevel(query);
	return {
		readOnly: confirmedReadonly,
		wholeTaskReadonly,
		wholeTaskMutationProhibited,
		confirmedReadonly,
		localFileMutationPossible,
		localCommandExecutionPossible,
		localExecutionPossible,
		unresolvedLocalArtifact,
		localReadonly: !wholeTaskReadonly && /(?:只读|read-only|readonly|审阅|审查|audit|review|inspect)/i.test(query),
		needsWeb: !prohibited.web && (profiles.includes("web") || profiles.includes("browser")),
		needsBrowser: !prohibited.browser && profiles.includes("browser"),
		needsComputer: !prohibited.computer && profiles.includes("computer"),
		needsMemory: recallLevel > 0,
		memoryRecallLevel: recallLevel,
		needsMemoryManage: memoryManage.needed,
		memoryManageOperation: memoryManage.operation,
		memoryUserScopeAuthorized: memoryManage.userScopeAuthorized,
		memoryManageDelivery: memoryManage.delivery,
		memoryWriteAuthorityTier: memoryManage.writeAuthorityTier,
		needsLong: profiles.includes("long"),
		explicitContinuation: explicitContinuationIntent(query),
		needsAgent: !prohibited.agent && profiles.includes("agent"),
		forbidWeb: prohibited.web,
		forbidBrowser: prohibited.browser,
		forbidComputer: prohibited.computer,
		forbidAgent: prohibited.agent,
		mutation,
	};
}

function requiredExecutionSurfaces(prompt, _profiles) {
	const query = lower(prompt);
	const prohibited = explicitCapabilityProhibitions(query);
	const surfaces = [];
	const supportedDocxCut = /\.docx\b/iu.test(query)
		&& /(?:删(?:除|掉|去|了)?|移除|清空|delete\b|remove\b|trim\b)/iu.test(query)
		&& /(?:之前|以前|前(?:面|的)?|before\b|prior\s+to\b)/iu.test(query)
		&& /(?:\[[^\]\r\n]{1,128}\]|时间|日期|时间戳|timestamp|marker)/iu.test(query);
	if (supportedDocxCut) surfaces.push("document");
	const browserAction = browserExecutionIntent(query);
	if (browserAction && !prohibited.browser) surfaces.push("browser");
	if (computerExecutionIntent(query) && !prohibited.computer) surfaces.push("computer");
	const chineseLookup = /(?:联网|网上|在线|互联网).{0,32}(?:搜索|查询|查找|获取|抓取|访问|查|最新|当前|资料|来源)/iu.test(query);
	const englishLookup = /(?:\b(?:search|browse|look\s+up|fetch)\b.{0,32}(?:web|internet|online|latest|current|github\s+(?:issue|release)|official\s+docs?|news)|(?:web|internet|online|latest|current|github\s+(?:issue|release)|official\s+docs?|news).{0,32}\b(?:search|browse|look\s+up|fetch)\b)/iu.test(query);
	if (!browserAction && !prohibited.web && (chineseLookup || englishLookup)) surfaces.push("web");
	return [...new Set(surfaces)];
}

function capabilityComposition(profiles, facts = {}) {
	const constraints = [];
	if (facts.wholeTaskReadonly) constraints.push("mutation tools unavailable");
	if (facts.forbidWeb) constraints.push("web tools unavailable by explicit user constraint");
	if (facts.forbidBrowser) constraints.push("browser tools unavailable by explicit user constraint");
	if (facts.forbidComputer) constraints.push("desktop computer tools unavailable by explicit user constraint");
	if (facts.forbidAgent) constraints.push("agent tools unavailable by explicit user constraint");
	const owners = profiles.flatMap((profile) => PROFILE_CAPABILITY_OWNERS[profile] || []);
	if (facts.needsMemory) owners.push("bounded memory recall");
	if (facts.needsMemoryManage) owners.push("user-explicit durable memory");
	return {
		owners: [...new Set(owners)],
		constraints,
	};
}

function policySectionTitles(prompt, profileRules) {
	const sections = profileRules.flatMap((rule) => rule.sections);
	if (/(?:agents?\.md|skill_menu|\bskill\b|canonical|protected|knowledge asset|规则文件|技能文件)/i.test(String(prompt || ""))) {
		sections.push("Protected Knowledge Assets");
	}
	return [...new Set(sections)];
}

function matchedMenuEntries(menu, prompt, immediate) {
	const query = lower(prompt);
	const menuEvidence = buildMenuEvidence(menu);
	const immediateNames = new Set(immediate.map((skill) => lower(skill.name)));
	const rows = (menu?.rules || [])
		.map((rule) => {
			const matchedBy = [];
			if (ruleMatchesPrompt(query, rule, menuEvidence)) matchedBy.push("prompt");
			if (rule.skills.some((skill) => immediateNames.has(lower(skill)))) matchedBy.push("winner");
			return matchedBy.length ? { source: rule.source, line: rule.line, entry: rule.entry, skills: rule.skills, matchedBy } : null;
		})
		.filter(Boolean);
	const promptRows = rows.filter((row) => row.matchedBy.includes("prompt"));
	const winnerRows = rows.filter((row) => row.matchedBy.includes("winner"));
	return (promptRows.length ? promptRows : winnerRows).slice(0, 12);
}

export function routePrompt(prompt, options = {}) {
	const rawPrompt = String(prompt || "");
	const allowPromptSkillDirective = options.allowPromptSkillDirective !== false;
	const routingPrompt = allowPromptSkillDirective ? rawPrompt : stripPromptSkillDirective(rawPrompt);
	const sources = resolveCanonicalSources({
		cwd: options.cwd,
		home: options.home,
		codexHome: options.codexHome,
	});
	let menu = readMenuRules(sources);
	const profiles = chooseProfiles(routingPrompt);
	if (profiles.length > 1 && sources.fullMenu) {
		menu = readMenuRules(sources, true);
	}
	const profileRules = profiles.map((profile) => PROFILE_RULES.find((rule) => rule.profile === profile)).filter(Boolean);
	const sectionTitles = policySectionTitles(routingPrompt, profileRules);
	const skills = chooseSkills(sources, rawPrompt, profiles, menu, {
		explicitSkill: options.explicitSkill,
		requiredSkill: options.requiredSkill,
		responsibilityRole: options.responsibilityRole,
		allowPromptSkillDirective,
	});
	const agentSections = readAgentSections(sources, sectionTitles);
	const facts = intentFacts(routingPrompt, profiles);
	const executionAuthorityPaths = localExecutionAuthorityPaths(routingPrompt, facts);
	const menuEntries = matchedMenuEntries(menu, routingPrompt, skills.immediate);
	const explicit = lower(options.explicitSkill || (allowPromptSkillDirective ? explicitSkillName(rawPrompt) : ""));
	const inherited = lower(options.requiredSkill);
	const requiredSkill = explicit ? skills.immediate[0]?.name : inherited ? skills.immediate[0]?.name : undefined;
	const skillSelection = Object.freeze({
		mode: explicit ? "explicit" : inherited ? "inherited_explicit" : "automatic",
		...(requiredSkill ? { requiredSkill } : {}),
	});
	const responsibilityRole = typeof options.responsibilityRole === "string" && options.responsibilityRole.trim()
		? options.responsibilityRole.trim()
		: undefined;
	const requiredSurfaces = requiredExecutionSurfaces(routingPrompt, profiles);
	return {
		prompt: rawPrompt,
		profile: profiles[0],
		profiles,
		reasons: routeReason(routingPrompt, profiles),
		intentFacts: facts,
		localExecutionAuthorityPaths: executionAuthorityPaths,
		capabilityComposition: capabilityComposition(profiles, facts),
		responsibilityRole,
		skillSelection,
		requiredExecutionSurfaces: requiredSurfaces,
		sources,
		skills,
		agentSections,
		menu: {
			litePath: sources.liteMenu,
			fullPath: sources.fullMenu,
			fullLoaded: menu.fullLoaded,
			mentionedSkills: menu.mentionedSkills,
			ruleCount: menu.rules.length,
			matchedEntries: menuEntries,
		},
	};
}

function sectionText(sections, existingSystemPrompt = "") {
	const existing = String(existingSystemPrompt || "");
	return sections
		.filter((section) => {
			const text = String(section?.text || "").trim();
			return !text || !existing.includes(text);
		})
		.map((section) => `<!-- pi-one canonical AGENTS section: ${section.title} (${section.scope}) -->\n${section.text}`)
		.join("\n\n");
}

function projectedIntentFacts(facts = {}) {
	const projected = {};
	for (const [key, value] of Object.entries(facts || {})) {
		if (value === true) projected[key] = true;
		else if (typeof value === "number" && value !== 0) projected[key] = value;
	}
	if (facts?.needsMemoryManage === true) {
		if (facts.memoryManageOperation) projected.memoryManageOperation = facts.memoryManageOperation;
		if (facts.memoryManageDelivery) projected.memoryManageDelivery = facts.memoryManageDelivery;
		if (facts.memoryWriteAuthorityTier) projected.memoryWriteAuthorityTier = facts.memoryWriteAuthorityTier;
	}
	return projected;
}

export function renderProjection(route, { existingSystemPrompt = "", includeSkillIndex = true } = {}) {
	const existing = String(existingSystemPrompt || "");
	const immediate = route.skills.immediate
		.filter((skill) => !(existing.includes(String(skill.name || "")) && existing.includes(String(skill.path || ""))))
		.map((skill) => `<!-- pi-one immediate Skill reference: ${skill.name} (${skill.path}) -->\n- description: ${skill.description || "(no frontmatter description)"}\n- hydrate exact file only when the task requires this Skill: ${skill.path}`)
		.join("\n\n");
	const deferred = route.skills.deferred
		.map((skill) => `- ${skill.name}: ${skill.path}; ${skill.trigger}`)
		.join("\n");
	const sections = sectionText(route.agentSections, existing);
	const projectedSectionCount = sections ? (route.agentSections || []).filter((section) => {
		const text = String(section?.text || "").trim();
		return !text || !existing.includes(text);
	}).length : 0;
	const omittedSectionCount = Math.max(0, (route.agentSections || []).length - projectedSectionCount);
	const skillIndex = [...(route.sources?.skillWinners?.values?.() || [])]
		.filter((skill) => skill?.explicitOnly !== true)
		.map((skill) => skill.name)
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right));
	const pieces = [
		"<pi-one-context>",
		`route=${route.profile}`,
		`profiles=${(route.profiles || [route.profile]).join(",")}`,
		`route-reasons=${route.reasons.join(",")}`,
		`intent-facts=${JSON.stringify(projectedIntentFacts(route.intentFacts))}`,
		`capability-owners=${route.capabilityComposition.owners.join(",")}`,
		"The following is a per-turn projection from canonical sources. It is not a new authority.",
		omittedSectionCount > 0 ? `shared-policy-source=upstream-project-context; omitted-duplicate-sections=${omittedSectionCount}` : "",
		includeSkillIndex && skillIndex.length ? `skill-index=${skillIndex.join(",")}; hydrate a missed candidate with skill_open(name)` : "",
		sections ? `\n## Selected shared policy sections\n${sections}` : "",
		immediate ? `\n## Immediate canonical Skills\n${immediate}` : "",
		deferred ? `\n## Deferred Skill pointers\n${deferred}` : "",
		"</pi-one-context>",
	].filter(Boolean);
	return pieces.join("\n");
}

/**
 * Freeze the effective canonical route for a Worker.  WorkerRuntime must not
 * resolve Skills or ambient AGENTS independently; this is the root route's
 * bounded projection and its material revision identity.
 */
export function createWorkerAuthoritySnapshot(route) {
	const projectionText = renderProjection(route, { includeSkillIndex: false });
	const filesByPath = new Map();
	for (const section of route.agentSections || []) {
		const key = String(section.path || "").toLowerCase();
		const current = filesByPath.get(key) || { path: section.path, content: [] };
		current.content.push(`## ${section.title}\n${section.text}`);
		filesByPath.set(key, current);
	}
	const authorityFiles = [...filesByPath.values()].map((file) => ({ path: file.path, content: file.content.join("\n\n") }));
	const projectAuthorityFiles = (route.sources?.projectAgents || []).map((filePath) => ({ path: filePath, content: readCanonicalText(filePath) }));
	const selectedSkills = (route.skills?.immediate || [])
		.filter((skill) => skill?.name && skill?.path)
		.map((skill) => Object.freeze({ name: skill.name, path: skill.path, codexNative: skill.codexNative === true }));
	const selectedSkillRefs = selectedSkills.map((skill) => skill.path);
	const selectedSkillSources = selectedSkillRefs.map((filePath) => ({ path: filePath, content: readCanonicalText(filePath) }));
	const authorityPaths = [...new Set([route.sources?.cwd, ...(route.localExecutionAuthorityPaths || [])].filter(Boolean))];
	const skillSelection = route.skillSelection || { mode: "automatic" };
	const routeIdentity = {
		profile: route.profile,
		profiles: [...(route.profiles || [route.profile])],
		responsibilityRole: route.responsibilityRole || null,
		skillSelection: {
			mode: skillSelection.mode || "automatic",
			...(skillSelection.requiredSkill ? { requiredSkill: skillSelection.requiredSkill } : {}),
		},
		requiredSkill: skillSelection.requiredSkill || null,
		requiredExecutionSurfaces: [...(route.requiredExecutionSurfaces || [])],
	};
	const canonicalAuthorityRevision = createAuthorityRevision({
		cwd: route.sources?.cwd,
		authorityPaths,
		authorityFiles: [...authorityFiles, ...projectAuthorityFiles],
		authorityFingerprints: selectedSkillSources,
		effectiveMenu: route.menu?.matchedEntries || [],
		selectedSkillRefs,
	});
	const projectionRevision = createAuthorityRevision({
		cwd: route.sources?.cwd,
		authorityPaths,
		authorityFiles: [...authorityFiles, ...projectAuthorityFiles],
		authorityProjection: projectionText,
		authorityFingerprints: selectedSkillSources,
		effectiveMenu: route.menu?.matchedEntries || [],
		selectedSkillRefs,
		workspace: routeIdentity,
	});
	return Object.freeze({
		projectionText,
		authorityPaths: Object.freeze(authorityPaths),
		authorityFiles: Object.freeze(authorityFiles.map((file) => Object.freeze(file))),
		projectAuthorityFiles: Object.freeze(projectAuthorityFiles.map((file) => Object.freeze(file))),
		selectedSkills: Object.freeze(selectedSkills),
		selectedSkillRefs: Object.freeze(selectedSkillRefs),
		canonicalAuthorityRevision,
		projectionRevision,
		// Compatibility alias while mutation/evidence consumers migrate incrementally.
		authorityRevision: canonicalAuthorityRevision,
		routeIdentity: Object.freeze(routeIdentity),
	});
}

export function createWorkerAuthoritySnapshotForResponsibility(rootRoute, request = {}, options = {}) {
	const sources = rootRoute?.sources || {};
	const requiredSkill = String(request.requiredSkill || "").trim()
		|| (rootRoute?.skillSelection?.mode === "explicit" ? rootRoute.skillSelection.requiredSkill : "");
	const routed = routePrompt(request.objective || "", {
		cwd: options.cwd || sources.cwd,
		home: options.home || sources.home,
		codexHome: options.codexHome || sources.codexHome,
		responsibilityRole: request.role,
		...(requiredSkill ? { requiredSkill } : {}),
		allowPromptSkillDirective: false,
	});
	const inheritedAuthorityPaths = rootRoute?.localExecutionAuthorityPaths || [];
	const route = inheritedAuthorityPaths.length
		? { ...routed, localExecutionAuthorityPaths: [...new Set([...(routed.localExecutionAuthorityPaths || []), ...inheritedAuthorityPaths])] }
		: routed;
	return createWorkerAuthoritySnapshot(route);
}

export function diagnosticSummary(route) {
	return {
		profile: route.profile,
		profiles: route.profiles || [route.profile],
		responsibilityRole: route.responsibilityRole,
		reasons: route.reasons,
		intentFacts: route.intentFacts,
		localExecutionAuthorityPaths: route.localExecutionAuthorityPaths || [],
		capabilityComposition: route.capabilityComposition,
		skillSelection: route.skillSelection,
		requiredExecutionSurfaces: route.requiredExecutionSurfaces || [],
		immediateSkills: route.skills.immediate.map(({ name, path }) => ({ name, path })),
		deferredSkills: route.skills.deferred,
		agentSections: route.agentSections.map(({ title, path, scope }) => ({ title, path, scope })),
		menu: route.menu,
		winner: route.skills.immediate.map(({ name, path, rootKind, candidates }) => ({ name, path, rootKind, candidateCount: candidates?.length ?? 0 })),
		canonical: sourceSummary(route.sources),
	};
}
