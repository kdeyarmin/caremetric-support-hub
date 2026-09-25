import {afterEach,describe,expect,it,vi} from 'vitest';
import {projectTrainingResponse,type TrainingOperation} from '../../supabase/functions/_shared/trainingProtocol';
import {trainingClient} from './trainingClient';
import {requestAdmin} from './transport';

vi.mock('./transport',()=>({requestAdmin:vi.fn()}));

const id='11111111-1111-4111-8111-111111111111';
const certificateOperation:TrainingOperation={domain:'training.v1',operation:'certificates.read',organizationId:id,certificateId:id};
const serverNow=Date.parse('2026-09-25T05:00:00Z');
const readyCertificate={certificateId:id,status:'ready',expiresAt:'2026-09-25T05:10:00Z',url:`https://xsqobvvreaovwibxwyvv.supabase.co/storage/v1/object/sign/certificates/${id}/${id}.pdf?token=test`};

afterEach(()=>{vi.restoreAllMocks();vi.mocked(requestAdmin).mockReset();});

describe('Hub training client',()=>{
  it.each([-86_400_000,-120_000,120_000,86_400_000])('accepts server-validated certificates with a %i ms workstation clock offset',async offset=>{
    // Model the actual server boundary before changing only the browser clock.
    const projected=projectTrainingResponse({...readyCertificate,privateKey:'stripped by server'},certificateOperation,undefined,serverNow);
    vi.mocked(requestAdmin).mockResolvedValue(projected);
    vi.spyOn(Date,'now').mockReturnValue(serverNow+offset);
    const signal=new AbortController().signal;
    await expect(trainingClient.request(certificateOperation,signal)).resolves.toEqual(readyCertificate);
    expect(requestAdmin).toHaveBeenCalledExactlyOnceWith('training',certificateOperation,signal);
  });

  it('preserves the server-projected pending certificate without inventing a link',async()=>{
    const pending={certificateId:id,status:'pending',url:null,expiresAt:null};
    vi.mocked(requestAdmin).mockResolvedValue(projectTrainingResponse(pending,certificateOperation,undefined,serverNow));
    await expect(trainingClient.request(certificateOperation,new AbortController().signal)).resolves.toEqual(pending);
  });

  it('propagates server rejection without converting it to a certificate result',async()=>{
    const rejection=new Error('Server rejected certificate response');
    vi.mocked(requestAdmin).mockRejectedValue(rejection);
    vi.spyOn(Date,'now').mockReturnValue(serverNow-86_400_000);
    await expect(trainingClient.request(certificateOperation,new AbortController().signal)).rejects.toBe(rejection);
  });

  it('retains response projection for other training operations',async()=>{
    const operation:TrainingOperation={domain:'training.v1',operation:'facilities.list',organizationId:id,search:'',limit:20,offset:0};
    vi.mocked(requestAdmin).mockResolvedValue({items:[],total:1,limit:20,offset:0});
    await expect(trainingClient.request(operation,new AbortController().signal)).rejects.toThrow('Invalid training contract');
  });
});
