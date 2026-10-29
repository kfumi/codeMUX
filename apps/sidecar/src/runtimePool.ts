import type { EnsureSessionCommand, RuntimeFlavor } from './types.js';
import { getRuntimeFlavor } from './runtimeEvents.js';
import type { SidecarRuntime } from './runtimePort.js';

/**
 * 四家 runtime 的注册表。
 *
 * singleton：claude / codex 整个 sidecar 生命周期只有一个实例；
 * managed：opencode / pi 按会话 ensure 创建，可被 canReuse 复用、切换时重建。
 */
export type RuntimeRegistration =
  | { kind: 'singleton'; runtime: SidecarRuntime }
  | { kind: 'managed'; create: (cmd: EnsureSessionCommand) => SidecarRuntime };

export type RuntimeRegistrations = Record<RuntimeFlavor, RuntimeRegistration>;

/**
 * runtime 选择与生命周期。
 *
 * dispatcher 不再按 flavor 挑 runtime：ensure 时从这里选注册项，之后的命令只问
 * `current()`。opencode/pi 的复用与重建、singleton 与 managed 的互斥也都在这里。
 */
export class SidecarRuntimePool {
  private activeKind: string | undefined;
  private managed: { flavor: RuntimeFlavor; runtime: SidecarRuntime } | undefined;

  constructor(private readonly registrations: RuntimeRegistrations) {}

  get agentKind(): string | undefined {
    return this.activeKind;
  }

  /** 未 ensure 过时按 claude 处理，与 dispatcher 的历史默认一致。 */
  get flavor(): RuntimeFlavor {
    return getRuntimeFlavor(this.activeKind);
  }

  setActiveKind(agentKind: string | undefined): void {
    if (agentKind) {
      this.activeKind = agentKind;
    }
  }

  current(): SidecarRuntime | undefined {
    const registration = this.registrations[this.flavor];
    if (registration.kind === 'singleton') {
      return registration.runtime;
    }
    return this.managed?.flavor === this.flavor ? this.managed.runtime : undefined;
  }

  async ensure(cmd: EnsureSessionCommand): Promise<void> {
    this.activeKind = cmd.agentKind;
    const flavor = this.flavor;
    const registration = this.registrations[flavor];

    if (registration.kind === 'singleton') {
      await this.shutdownManaged();
      await registration.runtime.ensure(cmd);
      return;
    }

    const current = this.managed;
    if (current?.flavor === flavor && current.runtime.canReuse?.(cmd)) {
      process.stderr.write(
        `[${flavor}-task] ensure_session REUSE sessionId=${cmd.sessionId ?? 'null'}\n`,
      );
      await current.runtime.updatePermissions({
        type: 'update_permissions',
        sessionId: cmd.sessionId,
        agentKind: cmd.agentKind,
        permissionConfig: cmd.permissionConfig,
        planMode: cmd.planMode,
      });
      current.runtime.emitSessionMapping?.(cmd);
      return;
    }

    await this.shutdownManaged();
    const nextRuntime = registration.create(cmd);
    try {
      await nextRuntime.ensure(cmd);
    } catch (error) {
      try {
        await nextRuntime.shutdown();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${String(error)}; ${flavor} cleanup failed: ${String(cleanupError)}`,
        );
      }
      throw error;
    }
    this.managed = { flavor, runtime: nextRuntime };
  }

  async shutdown(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.shutdownManaged();
    } catch (error) {
      errors.push(new Error(`managed runtime: ${String(error)}`));
    }

    const registration = this.registrations[this.flavor];
    if (registration.kind === 'singleton') {
      try {
        await registration.runtime.shutdown();
      } catch (error) {
        errors.push(new Error(`active runtime: ${String(error)}`));
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Sidecar runtime shutdown failed: ${errors.map(String).join('; ')}`,
      );
    }
  }

  private async shutdownManaged(): Promise<void> {
    const current = this.managed;
    if (!current) {
      return;
    }
    await current.runtime.shutdown();
    if (this.managed === current) {
      this.managed = undefined;
    }
  }
}
