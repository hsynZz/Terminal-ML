interface D1Result<T = Record<string, unknown>> { results:T[]; success:boolean; meta:{changes:number; duration:number; last_row_id:number; rows_read:number; rows_written:number; changed_db:boolean; size_after:number}; }
interface D1PreparedStatement {
  bind(...values:unknown[]):D1PreparedStatement;
  first<T=Record<string,unknown>>(column?:string):Promise<T|null>;
  all<T=Record<string,unknown>>():Promise<D1Result<T>>;
  run<T=Record<string,unknown>>():Promise<D1Result<T>>;
  raw<T=unknown[]>(options?:{columnNames?:boolean}):Promise<T[]>;
}
interface D1Database { prepare(sql:string):D1PreparedStatement; batch<T=unknown>(statements:D1PreparedStatement[]):Promise<D1Result<T>[]>; exec(query:string):Promise<{count:number;duration:number}>; }
interface Fetcher { fetch(request:Request|string,init?:RequestInit):Promise<Response>; }
declare module 'cloudflare:workers' { export const env: {DB:D1Database;[key:string]:unknown}; }
