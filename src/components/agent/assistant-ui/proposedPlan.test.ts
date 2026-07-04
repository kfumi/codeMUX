import { describe, expect, it } from 'vitest';

import { parseProposedPlan, getProposedPlanTitle, getProposedPlanSummary, getProposedPlanPreview } from './proposedPlan';

describe('parseProposedPlan', () => {
  it('提取完整 proposed_plan 并保留前后普通文本', () => {
    const parsed = parseProposedPlan('前言\n<proposed_plan>\n# 计划标题\n\nSummary\n正文\n</proposed_plan>\n尾声');

    expect(parsed).toEqual({
      beforeText: '前言',
      planMarkdown: '# 计划标题\n\nSummary\n正文',
      afterText: '尾声',
    });
  });

  it('未闭合标签不解析', () => {
    expect(parseProposedPlan('前言\n<proposed_plan>\n# 计划标题')).toBeNull();
  });

  it('提取 Markdown 一级标题作为卡片标题', () => {
    expect(getProposedPlanTitle('\n# 贪吃蛇浏览器小游戏\n\n## Summary')).toBe('贪吃蛇浏览器小游戏');
    expect(getProposedPlanTitle('没有标题')).toBe('计划');
  });

  it('优先提取 Summary 段落作为摘要', () => {
    const summary = getProposedPlanSummary(`# 标题

## Summary
这里是第一段摘要。
这里是第二行。

## Key Changes
- 不应该进入摘要`);

    expect(summary).toBe('这里是第一段摘要。\n这里是第二行。');
  });

  it('预览内容保留二级标题，避免对话卡片吃掉摘要标题', () => {
    const preview = getProposedPlanPreview(`# 标题

## 摘要
这里是摘要正文。

## 关键改动
- 不应该进入摘要`);

    expect(preview).toBe('## 摘要\n这里是摘要正文。');
  });
});
