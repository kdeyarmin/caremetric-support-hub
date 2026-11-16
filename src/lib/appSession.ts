import { config } from './config';

const authEvent = 'caremetric:session';
/** Raised whenever the sign-in may have changed (or lapsed) so the shell re-checks it. */
export const sessionEvent = authEvent;
export class AppRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'AppRequestError'; }
}
/**
 * The message a failed Hub response carries for the person, or null. The server sends either a plain message or, for a coded
 * error, `{ code, message? }` with a message only when it is safe to show (server/http.mjs).
 */
export function responseErrorMessage(data: unknown): string | null {
  const error = data && typeof data === 'object' && 'error' in data ? (data as { error: unknown }).error : null;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') return (error as { message: string }).message;
  return null;
}
export async function appRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store', redirect:'error',
    headers: body === undefined ? {} : { 'Content-Type':'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  // Gateways can return HTML or an empty body during an outage. Session expiry
  // must still reach the shell, even when that response is not valid JSON.
  if (response.status === 401 && !path.startsWith('auth/')) window.dispatchEvent(new Event(authEvent));
  let data: { error?:string | { code?:string; message?:string } } & T;
  try { data = await response.json(); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new AppRequestError(response.ok ? 'The server returned an unreadable response. Please try again.' : 'The request could not be completed. Please try again.', response.status);
  }
  if (!response.ok) {
    throw new AppRequestError(responseErrorMessage(data) ?? 'The request could not be completed.', response.status);
  }
  return data;
}
export const appSession = {
  current: () => config.demoMode ? Promise.resolve({ authenticated:true }) : appRequest<{ authenticated:boolean; userId?:string; method?:string }>('auth/session'),
  start: (phone:string) => appRequest<{ challengeId:string; retryAfter:number }>('auth/sms/start',{ phone }),
  async verify(challengeId:string,code:string) {
    await appRequest('auth/sms/verify',{ challengeId,code });
    window.dispatchEvent(new Event(authEvent));
  },
  async signInWithPassword(username:string,password:string) {
    await appRequest('auth/password/login',{ username,password });
    window.dispatchEvent(new Event(authEvent));
  },
  passwordSettings: (signal?:AbortSignal) => appRequest<{username:string;configured:boolean;can_reset:boolean}>('auth/password/settings',undefined,signal),
  savePassword: (input:{username:string;password:string;currentPassword?:string}) => appRequest('auth/password/settings',input),
  startInvitation: (input:{claimCode:string;phone:string;consent:true})=>appRequest<{challengeId:string;retryAfter:number}>('auth/invitation/start',input),
  async verifyInvitation(challengeId:string,code:string){
    await appRequest('auth/invitation/verify',{challengeId,code});
    window.dispatchEvent(new Event(authEvent));
  },
  async signOut() {
    await appRequest('auth/logout',{});
    window.dispatchEvent(new Event(authEvent));
  },
  subscribe(listener:() => void) {
    window.addEventListener(authEvent,listener);
    return () => window.removeEventListener(authEvent,listener);
  },
};

export async function hubRpc(name:string,args?:Record<string,unknown>) {
  return appRequest<unknown>(`rpc/${name}`,args ?? {});
}

export const hubClient = {
  async rpc(name:string,args?:Record<string,unknown>): Promise<{ data:unknown; error:Error|null }> {
    try { return { data:await hubRpc(name,args),error:null }; }
    catch (error) { return { data:null,error:error instanceof Error ? error : new Error('Request failed.') }; }
  },
};
