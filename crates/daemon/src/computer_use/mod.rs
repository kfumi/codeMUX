//! 电脑控制(工单 03-06、13):统一审批闸门、桌面观测与输入、驱动托管。
//!
//! 三级能力共用同一条闸门:浏览器级(01 票的自动化接缝)、桌面只读观测
//! (04 票)、系统级执行(05/06 票的驱动子进程;13 票起桌面输入也走这条)。
//! 闸门只认风险级与敏感场景,不认智能体权限档位 —— 输入动作在任何档位下
//! 都要人工放行(或由人给出限时授权),见 [`guard`] 的模块文档。
//!
//! 工单 01 起还有一条**活动真值**(见 [`activity`]):哪个回合试图驱动过桌面 —— 提示条
//! 与全局 Esc 的判据在 daemon 侧,不再依赖渲染层是否在跑。

pub mod activity;
pub mod approval;
pub mod desktop;
pub mod driver;
pub mod guard;
pub mod page_context;
pub mod policy;
pub mod probe;
pub mod routes;
