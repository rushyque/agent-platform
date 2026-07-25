// 最小化的 mssql 类型声明（mssql@12 未自带 .d.ts，@types/mssql 未安装）
// 只覆盖 agent-platform 用到的 API 子集。

declare module "mssql" {
  export interface ConnectionConfig {
    server: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    options?: {
      encrypt?: boolean;
      trustServerCertificate?: boolean;
      enableArithAbort?: boolean;
      [key: string]: any;
    };
    [key: string]: any;
  }

  export interface ISqlTypeFactory {
    (length?: number | "MAX"): any;
  }

  export interface IRequest {
    input(name: string, type?: any, value?: any): IRequest;
    query(command: string): Promise<IResult<any>>;
    query<T>(command: string): Promise<IResult<T>>;
    batch(command: string): Promise<IResult<any>>;
  }

  export interface IResult<T> {
    recordset: T[];
    recordsets: T[][];
    rowsAffected: number[];
    output: Record<string, any>;
  }

  export interface IConnectionPool {
    connected: boolean;
    request(): IRequest;
    close(): Promise<void>;
  }

  export const Int: any;
  export const BigInt: any;
  export const NVarChar: any;
  export const VarChar: any;
  export const Bit: any;
  export const DateTime: any;
  export const DateTime2: any;
  export const MAX: any;
  export const JSON: any;

  export function connect(config: ConnectionConfig | string): Promise<IConnectionPool>;
  export function close(): Promise<void>;

  const _default: {
    connect: typeof connect;
    close: typeof close;
    Int: any;
    BigInt: any;
    NVarChar: any;
    VarChar: any;
    Bit: any;
    DateTime: any;
    DateTime2: any;
    MAX: any;
    JSON: any;
  };
  export default _default;
}
