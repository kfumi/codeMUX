/**
 * 更新状态的展示映射(UpdateEntry 与 AboutSettings 共用)。
 *
 * 单独抽出来的原因:两处入口展示的是同一份 state,文案/百分比口径必须一致 ——
 * 之前 AboutSettings 完全不渲染 downloading/installing/error,导致「在关于页点
 * 下载并安装后界面零变化」,而 UpdateEntry 又会在 error 时整块消失(把
 * 0b5ce063 的「检查失败隐藏入口」误用到了下载失败场景)。
 */
import type { UpdateProgress, UpdateStage } from './hooks/useUpdater';

export type UpdateEntryTone = 'available' | 'busy' | 'error';

export interface UpdateEntryView {
  label: string;
  /** 次级说明:标题栏按钮放进 tooltip。 */
  hint: string;
  /**
   * 失败时的原始原因(已压成单行)。独立于 hint,便于关于页展示 ——
   * hint 带「点击重试」这类只对可点按钮成立的措辞。
   */
  detail?: string;
  disabled: boolean;
  tone: UpdateEntryTone;
}

/** 百分比;总量未知(totalBytes 为 null/0)时返回 null,由 UI 退化为不确定态。 */
export function getUpdatePercent(progress?: UpdateProgress): number | null {
  const totalBytes = progress?.totalBytes;
  const downloadedBytes = progress?.downloadedBytes ?? 0;

  if (!totalBytes || totalBytes <= 0) {
    return null;
  }

  return Math.min(100, Math.max(0, Math.round((downloadedBytes / totalBytes) * 100)));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/**
 * 阶段 → 展示模型。`error` 有分支(失败时**保留入口**并给出重试),
 * 这正是修复「点了升级没反应」的关键:之前这里返回 null,按钮直接消失。
 */
export function getUpdateEntryView(
  stage: UpdateStage,
  progress?: UpdateProgress,
  error?: string,
): UpdateEntryView | null {
  if (stage === 'available') {
    return {
      label: '更新',
      hint: '发现新版本，点击安装',
      disabled: false,
      tone: 'available',
    };
  }

  if (stage === 'downloading') {
    const percent = getUpdatePercent(progress);
    return {
      label: percent === null ? '下载中' : `下载中 ${percent}%`,
      hint: '正在下载更新',
      disabled: true,
      tone: 'busy',
    };
  }

  if (stage === 'installing') {
    return { label: '安装中', hint: '正在安装更新', disabled: true, tone: 'busy' };
  }

  if (stage === 'restarting') {
    return { label: '重启中', hint: '正在重启应用', disabled: true, tone: 'busy' };
  }

  if (stage === 'error') {
    // 底层原因(404/校验和/网络)可能很长且含英文技术信息,这里只做截断,
    // 完整原因留在壳侧 updater.log。
    const detail = error ? truncate(error, 120) : undefined;
    return {
      label: '更新失败',
      detail,
      hint: detail ? `更新失败：${truncate(detail, 60)}，点击重试` : '更新失败，点击重试',
      disabled: false,
      tone: 'error',
    };
  }

  return null;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
