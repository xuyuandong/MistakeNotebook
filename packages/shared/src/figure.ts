/**
 * 依赖图形作答的题目识别(确定性规则,PRD 5.3/6.3):
 * 导入数据不携带图形,题干指向插图(几何图/函数图象/统计图等)的题目学生无法作答。
 * 这类题目保留在错题统计与 AI 分析里,但不进入练习(出旧题/编新题)与复习到期列表。
 * 识别依据:题干保留“如图”等原表述,或按豆包模板规则 10 打了【依赖图形】标记。
 */
const FIGURE_DEPENDENT_RE = /【依赖图形】|如图|见图|图中|右图|左图|上图|下图/;

export function isFigureDependent(text: string): boolean {
  return FIGURE_DEPENDENT_RE.test(text);
}
