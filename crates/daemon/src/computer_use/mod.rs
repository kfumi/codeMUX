//! 电脑控制(工单 03-06):统一审批闸门、桌面只读观测与驱动托管。
//!
//! 三级能力共用同一条闸门:浏览器级(01 票的自动化接缝)、桌面只读观测
//! (04 票)、系统级执行(05/06 票的驱动子进程)。闸门只认风险级与敏感
//! 场景,不认智能体权限档位 —— 输入动作在任何档位下都要人工放行,见
//! [`guard`] 的模块文档。

pub mod approval;
pub mod driver;
pub mod guard;
pub mod page_context;
pub mod policy;
pub mod probe;
pub mod routes;
