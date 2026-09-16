export interface VendorMonacoResult {
  /** 版本戳命中时为 false(未发生拷贝)。 */
  changed: boolean;
  version: string;
  /** 被剥离 sourceMappingURL 引用的文件数。 */
  stripped: number;
}

export declare function vendorMonaco(options?: {
  /** 忽略版本戳强制重拷。 */
  force?: boolean;
  /** 抑制成功日志。 */
  quiet?: boolean;
}): VendorMonacoResult;

/** vendor 产物目录(仓库内的 public/vs 绝对路径)。 */
export declare const publicVendorDir: string;
