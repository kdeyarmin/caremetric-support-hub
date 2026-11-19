import { useRef, useState } from 'react';
import { appRequest } from '../lib/appSession';

export function RequestHumanSupport({ caseId, aiStage, onChanged }: { caseId: string; aiStage?: string | null; onChanged: () => void }) {
  const [state, setState] = useState<'ready' | 'saving' | 'requested'>('ready');
  const [error, setError] = useState('');
  const requestId = useRef<string | null>(null);
  const requested = state === 'requested' || aiStage === 'halted' || aiStage === 'exhausted';
  async function request() {
    setState('saving'); setError('');
    requestId.current ??= crypto.randomUUID();
    try {
      await appRequest('rpc/request_human_support', { p_case_id: caseId, p_request_key: requestId.current });
      setState('requested'); onChanged();
    } catch (cause) {
      setState('ready'); setError(cause instanceof Error ? cause.message : 'Human support could not be requested. Try again.');
    }
  }
  return <div className="panel">
    {requested ? <p role="status">Human support has been requested. Automated attempts have stopped; the support team will follow up here.</p> : <>
      <p>You can ask a person for help at any time.</p>
      <button type="button" className="button button-secondary" disabled={state === 'saving'} onClick={() => void request()}>{state === 'saving' ? 'Requesting…' : 'Request human support'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
