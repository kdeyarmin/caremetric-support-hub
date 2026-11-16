import { expect, it } from 'vitest';
import { onboardingRequest, projectSupportIdentity, supportIdentity } from './onboardingProtocol';
const id='11111111-1111-4111-8111-111111111111';
const value={product:'caremetric-go',sourceUserId:id,sourceAccountId:id,accountKind:'organization',relationship:'organization_member',revision:'a'.repeat(64)};
it('enforces individual, agency and organization account relationships without inventing organizations',()=>{
  expect(supportIdentity.parse(value)).toEqual(value);
  for(const invalid of [{...value,product:'intel'},{...value,product:'pennsync'},{...value,accountKind:'individual'},{...value,relationship:'agency_member'},{...value,revision:'unverified'}, {...value,patient:'not permitted'}])expect(supportIdentity.safeParse(invalid).success).toBe(false);
  expect(supportIdentity.safeParse({...value,product:'breathe',sourceUserId:'Preserve_CASE'}).success).toBe(true);
});
it('requires exact operation, product and native identifiers in the native response',()=>{
  const operation={operation:'support.identity.resolve' as const,sourceUserId:id,sourceAccountId:id};
  const envelope={contractVersion:1,product:'caremetric-go',operation:operation.operation,generatedAt:new Date().toISOString(),data:value};
  expect(projectSupportIdentity(envelope,'caremetric-go',operation)).toEqual(value);
  expect(()=>projectSupportIdentity({...envelope,product:'caremetric-emr'},'caremetric-go',operation)).toThrow();
  expect(()=>projectSupportIdentity(envelope,'caremetric-go',{...operation,sourceUserId:'22222222-2222-4222-8222-222222222222'})).toThrow();
});
it('accepts only explicit reviewed apply and closed preview parameters',()=>{
  const apply={operation:'apply',intentId:id,proofDigest:'a'.repeat(64),requestId:id,reviewed:true};
  expect(onboardingRequest.safeParse(apply).success).toBe(true);
  for(const invalid of [{...apply,reviewed:false},{...apply,hubUserId:id},{...apply,intakeEnabled:true},{operation:'preview',product:'carebase'}])expect(onboardingRequest.safeParse(invalid).success).toBe(false);
});
it('offers only applications whose administration connection can verify an account', async ()=>{
  const { applicationChoices, connectedOnboardingProducts } = await import('./onboardingProtocol');
  // EMR, Go and PennSync were disconnected on 2026-10-28: the server refuses their capabilities, so linking one can only fail.
  expect(connectedOnboardingProducts).toEqual(['carebase','breathe','intel']);
  expect(applicationChoices('breathe')).toEqual(['carebase','breathe','intel']);
  // An earlier invitation for a disconnected application still shows which one it names.
  expect(applicationChoices('caremetric-go')).toEqual(['caremetric-go','carebase','breathe','intel']);
});
