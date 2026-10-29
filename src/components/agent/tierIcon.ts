/**
 * 档位图标名 → Lucide 组件。
 *
 * 数据层只出名字（`TierIconName`），图标是组件层的事 —— `src/lib` 至今零
 * `lucide-react` 导入，这条边界不该为了少写这 12 行而破掉。
 *
 * 两个消费方（发送框下拉、设置页卡片网格）共用这一份，避免「同一档在两处
 * 画不同图标」。
 */
import {
  ClipboardList,
  Eye,
  Hand,
  Shield,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import type { TierIconName } from '../../lib/agentKind';

const TIER_ICONS: Record<TierIconName, LucideIcon> = {
  hand: Hand,
  'shield-check': ShieldCheck,
  zap: Zap,
  'clipboard-list': ClipboardList,
  shield: Shield,
  eye: Eye,
};

export function tierIcon(name: TierIconName): LucideIcon {
  return TIER_ICONS[name];
}
