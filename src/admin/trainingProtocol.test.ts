import {describe,expect,it} from 'vitest';
import {parseTrainingOperation,projectTrainingResponse,type TrainingReportOperation,type TrainingCommand} from '../../supabase/functions/_shared/trainingProtocol';
import {parsePortfolioEnvelope} from '../../supabase/functions/_shared/portfolioProtocol';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const report:TrainingReportOperation={domain:'training.v1',operation:'enrollments.report',organizationId:id,facilityId:null,courseSearch:'',status:'all',dateBasis:'assigned',dateFrom:null,dateThrough:null,limit:10000,offset:0};
const command:TrainingCommand={domain:'training.v1',operation:'apply',requestId:id,action:'facilities.provision',organizationId:null,parameters:{organizationName:'Test organization',facilityName:'Test facility',facilityType:'ALR'},reason:'Training facility setup'};
const row={id,employee_id:id,student:'Test student',facility_id:id,facility:'Test facility',course_id:id,course:'Training course',status:'completed',assigned_at:'2026-09-25T01:00:00Z',due_date:null,completed_at:'2026-09-25T01:30:00Z',percent_complete:100,certificate_id:id,credential_number:'TEST-1',certificate_issued_at:'2026-09-25T01:31:00Z',certificate_pdf_status:'pending'};
const page={organization_name:'Test organization',facility_name:null,generated_at:'2026-09-25T02:00:00Z',date_basis:'assigned',limit:10000,offset:0,total:1,students:1,completed:1,in_progress:0,not_started:0,canceled:0,completion_denominator:1,certificates:1,rows:[row]};
describe('training request boundary',()=>{
  it('accepts explicit owner scope and a complete export in one snapshot',()=>{expect(parseTrainingOperation(report)).toEqual(report);expect(parseTrainingOperation(command)).toEqual(command);});
  it('rejects scope, identity, product, pagination and date confusion',()=>{
    for(const value of [{...report,actor:id},{...report,organizationId:null},{...report,domain:'other'}, {...report,offset:1},{...report,limit:501},{...report,dateFrom:'2026-02-30'},{...report,dateFrom:'2026-09-25',dateThrough:'2026-09-24'}, {...command,organizationId:id},{...command,parameters:{...command.parameters,role:'platform_admin'}},{...command,reason:'short'}])expect(()=>parseTrainingOperation(value)).toThrow();
  });
  it('keeps admin and student invitations distinct and rejects unpublished course choices',()=>{
    const invite={...command,action:'invitations.create',organizationId:id,parameters:{role:'org_admin',firstName:'Test',lastName:'Admin',email:'test@example.invalid',facilityId:null,employeeId:null}};
    expect(parseTrainingOperation(invite)).toEqual(invite);
    for(const parameters of [{...invite.parameters,role:'platform_admin'},{...invite.parameters,employeeId:id},{...invite.parameters,role:'employee'},{employeeId:id,courseId:id,versionId:null,dueDate:null}])expect(()=>parseTrainingOperation({...invite,action:'versionId' in parameters?'enrollments.assign':'invitations.create',parameters})).toThrow();
  });
});
describe('training response boundary',()=>{
  it('projects only report evidence and refuses partial or inconsistent exports',()=>{
    expect(projectTrainingResponse({...page,privateKey:'never returned',rows:[{...row,employeeSsn:'never returned'}]},report)).toEqual(page);
    for(const value of [{...page,total:2},{...page,total:10001},{...page,completion_denominator:0},{...page,rows:[{...row,percent_complete:101}]},{...page,rows:[{...row,assigned_at:'invalid'}]}])expect(()=>projectTrainingResponse(value,report)).toThrow();
    expect(()=>projectTrainingResponse(page,{...report,facilityId:other})).toThrow();
    expect(()=>projectTrainingResponse(page,{...report,status:'in_progress'})).toThrow();
    expect(projectTrainingResponse(page,{...report,status:'completed'})).toEqual(page);
    expect(()=>projectTrainingResponse({...page,date_basis:'certificate',rows:[{...row,certificate_id:null,certificate_issued_at:null}]},{...report,dateBasis:'certificate'})).toThrow();
  });
  it('binds command receipts to reviewed request, target and result',()=>{
    const receipt={requestId:id,action:'facilities.provision',organizationId:other,replayed:false,result:{organizationId:other,facilityId:id,privateSecret:'stripped'}};
    expect(projectTrainingResponse(receipt,command)).toEqual({...receipt,result:{organizationId:other,facilityId:id}});
    expect(()=>projectTrainingResponse({...receipt,requestId:other},command)).toThrow();
    expect(()=>projectTrainingResponse({...receipt,result:{organizationId:id,facilityId:id}},command)).toThrow();
  });
  it('accepts imported students without hire dates and rejects silent directory truncation',()=>{
    const op=parseTrainingOperation({domain:'training.v1',operation:'students.list',organizationId:id,facilityId:id,limit:20,offset:0,search:'',status:'all'});
    const student={id,firstName:'Test',lastName:'Student',email:null,jobTitle:'Staff',hireDate:null,isActive:true,status:'active',profileId:null};
    const result={items:[student],total:1,limit:20,offset:0};expect(projectTrainingResponse(result,op)).toEqual(result);
    expect(()=>projectTrainingResponse({...result,total:2},op)).toThrow();
  });
  it('only returns explicitly scoped native certificate links, and no URL for unready PDFs',()=>{
    const op=parseTrainingOperation({domain:'training.v1',operation:'certificates.read',organizationId:id,certificateId:id});
    const now=Date.now();
    const result={certificateId:id,status:'ready',expiresAt:new Date(now+600_000).toISOString(),url:`https://xsqobvvreaovwibxwyvv.supabase.co/storage/v1/object/sign/certificates/${id}/${id}.pdf?token=test`};
    expect(projectTrainingResponse(result,op)).toEqual(result);
    for(const value of [{...result,certificateId:other},{...result,url:'https://evil.test/file.pdf'},{...result,url:result.url.replace('/certificates/','/avatars/')},{...result,status:'pending'},{...result,url:null}])expect(()=>projectTrainingResponse(value,op)).toThrow();
    for(const path of [`${other}/${id}.pdf`,`${id}/${other}.pdf`,`nested/${id}/${id}.pdf`,`${id}/%2e%2e/${id}.pdf`])expect(()=>projectTrainingResponse({...result,url:`https://xsqobvvreaovwibxwyvv.supabase.co/storage/v1/object/sign/certificates/${path}?token=test`},op)).toThrow();
    for(const expiresAt of [new Date(now-1).toISOString(),new Date(now+660_001).toISOString()])expect(()=>projectTrainingResponse({...result,expiresAt},op,undefined,now)).toThrow();
    expect(projectTrainingResponse({...result,expiresAt:new Date(now+660_000).toISOString()},op,undefined,now)).toMatchObject({status:'ready'});
  });
  it('never advertises CareBase training for another app',()=>{
    const response={contractVersion:1,product:'breathe',operation:'capabilities',generatedAt:'2026-09-25T02:00:00Z',data:{apiVersion:1,operations:['training.v1','overview'],sourceRevision:null}};
    expect(parsePortfolioEnvelope(response,{product:'breathe',operation:{operation:'capabilities'}}).data).toMatchObject({operations:['overview']});
  });
});
