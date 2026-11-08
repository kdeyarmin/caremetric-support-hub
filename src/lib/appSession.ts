import { config } from './config';

const authEvent = 'caremetric:session';
/** Raised whenever the sign-in may have changed (or lapsed) so the shell re-checks it. */
export const sessionEvent = authEvent;
export async function appRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store', redirect:'error',
    headers: body === undefined ? {} : { 'Content-Type':'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  const data = await response.json() as { error?:string | { code?:string; message?:string } } & T;
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('auth/')) window.dispatchEvent(new Event(authEvent));
    // A coded error carries a message only when the server marked it as safe to show.
    const error = data.error;
    const message = typeof error === 'string' ? error : typeof error === 'object' && error !== null && typeof error.message === 'string' ? error.message : null;
    throw new Error(message ?? 'The request could not be completed.');
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
