"""Nanobot runtime with ONE backend-owned tool. No shell, filesystem or network tools."""
import asyncio, json, sys, uuid
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')
from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.base import Tool
from nanobot.bus.queue import MessageBus
from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest

def memory_stats():
    if sys.platform!='win32': return {}
    import ctypes
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_=[('cb',wintypes.DWORD),('PageFaultCount',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
    counters=Counters();counters.cb=ctypes.sizeof(counters)
    if ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(-1),ctypes.byref(counters),counters.cb):return {'peakWorkingSetBytes':counters.PeakWorkingSetSize,'workingSetBytes':counters.WorkingSetSize}
    return {}

async def rpc(kind, payload):
    ident=uuid.uuid4().hex
    print(json.dumps({'kind':kind,'id':ident,'payload':payload},ensure_ascii=False),flush=True)
    line=await asyncio.to_thread(sys.stdin.readline)
    if not line: raise RuntimeError('Studio bridge disconnected')
    response=json.loads(line)
    if response.get('id')!=ident: raise RuntimeError('Studio bridge response mismatch')
    if response.get('error'): raise RuntimeError('Studio bridge request failed')
    return response.get('result')

class StudioTool(Tool):
    @property
    def name(self): return 'studio_action'
    @property
    def description(self): return 'Use only the studio backend allowlist. Backend validates owner authorization and page scope.'
    @property
    def parameters(self): return {'type':'object','properties':{k:{'type':'string'} for k in ['tool','page','videoId','referenceId','revisionId']},'required':['tool','page']}
    async def execute(self, **kwargs): return json.dumps(await rpc('tool',kwargs),ensure_ascii=False)

class StudioProvider(LLMProvider):
    def get_default_model(self): return 'studio-gemini'
    async def chat(self,messages,tools=None,model=None,**kwargs):
        value=await rpc('model',{'messages':messages})
        action=value.get('tool','none')
        if action and action!='none':
            args={k:str(value.get(k,'') or '') for k in ['tool','page','videoId','referenceId','revisionId']}
            return LLMResponse(content=None,tool_calls=[ToolCallRequest(id=uuid.uuid4().hex,name='studio_action',arguments=args)])
        return LLMResponse(content=value.get('answer') or 'ما توفرش جواب واضح لهاد الطلب.')

class SafeStudioLoop(AgentLoop):
    def _register_default_tools(self, **kwargs):
        self.tools.register(StudioTool())

async def main():
    request=json.loads(sys.stdin.readline())
    workspace=Path(request['workspace']).resolve()
    loop=SafeStudioLoop(bus=MessageBus(),provider=StudioProvider(),workspace=workspace,max_iterations=4,max_tool_result_chars=16000,context_window_tokens=32000,restrict_to_workspace=True,disabled_skills=['*'],session_ttl_minutes=0)
    if loop.tool_names!=['studio_action']: raise RuntimeError('Unexpected Nanobot tool exposure')
    session=loop.sessions.get_or_create('studio:owner')
    user_indices=[i for i,m in enumerate(session.messages) if m.get('role')=='user']
    if len(user_indices)>8:
        session.messages=session.messages[user_indices[-8]:]
        loop.sessions.save(session)
    out=await loop.process_direct(request['text'],session_key='studio:owner',channel='studio',chat_id='owner')
    print(json.dumps({'kind':'final','answer':out.content if out else 'ما توفرش جواب نهائي.','engine':'nanobot','tools':loop.tool_names,'stats':memory_stats()},ensure_ascii=False),flush=True)

try: asyncio.run(main())
except Exception as exc:
    print(json.dumps({'kind':'failure','error':type(exc).__name__}),flush=True)
    sys.exit(1)
