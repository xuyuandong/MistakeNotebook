import raw from "../../../llm_prompts/doubao_extract.md?raw";
import { stripFrontmatter } from "@mistake-book/shared";

/**
 * 豆包识题模板(唯一真源:仓库根 llm_prompts/doubao_extract.md,构建时内嵌并去掉 frontmatter)。
 * 版本与维护规则见该文件和 llm_prompts/README.md;不要在这里改文案。
 */
export const DOUBAO_TEMPLATE: string = stripFrontmatter(raw).body;
