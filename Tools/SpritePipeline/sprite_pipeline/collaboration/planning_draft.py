"""A strategy draft is not an executable provider request (policy 4 only).

The already-scheduled coordinator authors the bounded final brief. This does
not repair an invalid response, discard fields or add a paid rewriting turn.
Legacy strategy schemas keep their existing limits.
"""
from pydantic import Field
from .contracts import PlanStage,PlanProposal,StrategyTurn,ExpertTurn


class StrategyDraftStage(PlanStage):
    prompt: str = Field(min_length=8,max_length=4000,
        description='Strategy analysis draft only, not executable provider text. Keep concrete local motion and constraints; the coordinator writes the final <=1000-character drawing brief.')


class StrategyDraftPlan(PlanProposal):
    stages: list[StrategyDraftStage] = Field(min_length=1,max_length=4)


class DraftStrategyTurn(StrategyTurn):
    proposal: StrategyDraftPlan | None = None


class DraftInternalTurn(ExpertTurn):
    proposal: StrategyDraftPlan | None = None


def instructions(legacy,role):
    from .generation_conditions import planning_instructions
    text=planning_instructions(legacy,policy_version=3)
    text=text.replace('EXECUTABLE DRAWING BRIEF policy 3','EXECUTABLE DRAWING BRIEF policy 4')
    text=text.replace('Each stage.prompt is the COMPLETE text sent to PixelLab, unchanged. Write it once,\npreferably 650-850 characters, absolute maximum 1000 including headings/newlines.',
        'Only the COORDINATOR final plan.stage.prompt is sent to PixelLab, unchanged.\nWrite 12 SHORT labelled fragments, about 60-80 English words TOTAL per stage,\npreferably 450-750 characters, absolute maximum 1000 including headings/newlines.\nUse telegraphic clauses, not 12 full sentences or repetitions of the detailed analysis.')
    text=text.replace('Strategy proposes this same complete brief; coordinator checks coherence against\nthe detailed plan and original request.',
        'Strategy provides a NONEXECUTABLE analysis draft; it does not need these headings\nor the final provider length. Its draft prompt has a separate 4000-character safety\nceiling. Prefer a concise local transition with the detailed constraints in their\nnormal fields. Coordinator checks that draft and writes the complete final brief\nin its one already-scheduled turn, preserving the task and required relationships.\nA draft is never bound to a job or sent for drawing. This is normal planning,\nnot retrying an invalid response. Never add a compression/repair model call.')
    if role=='strategy':
        text+='\nYOUR ROLE NOW: propose the analysis draft; DO NOT attempt a provider-ready 12-section prompt. The coordinator handles that final representation.\n'
    elif role=='coordinator':
        text+='\nYOUR ROLE NOW: finalize actual <=1000-character briefs from the draft. Use short English phrases, about 60-80 words total per stage including labels; keep detailed reasoning in the other fields. The application sends this exact brief without suffixes or truncation.\n'
    return text


def draft_budget(messages):
    result=[]
    for message in messages:
        if message.get('role')!='strategy':continue
        draft=message.get('response',{}).get('proposal')
        if draft:
            result=[{'stage':i,'draft_characters':len(s['prompt']),'final_provider_limit':1000,
                'draft_is_executable':False} for i,s in enumerate(draft['stages'])]
    return result
