"""Explicit offline UI test service. Never used by production launchers."""
import sys
from pathlib import Path
from dataclasses import replace
from unittest.mock import patch
from contextlib import ExitStack

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_open_motion import Planner, Provider
from test_harness_integration import TemporaryHarness
from sprite_pipeline.api_app import create_api
from sprite_pipeline.service import SpritePipelineService
from sprite_pipeline.vision_review import VisionReviewer
import uvicorn

root = Path(sys.argv[1]).resolve()
fixture = TemporaryHarness(root)
from object_test_fixtures import write_interactable
write_interactable(root)
fixture.write_sequence(root/'target-fixture')
service = SpritePipelineService(root)
service.settings = replace(service.settings, poll_interval_seconds=0.25)
if '--checkpoints' in sys.argv:
    from test_open_motion_checkpoints import CheckpointPlanner
    service.open_motion_model = CheckpointPlanner()
else:
    service.open_motion_model = Planner()
from test_interactable_motion import PropPlanner
character_planner = service.open_motion_model
# The scripted prop plan defaults to a hinge (needs a checked structure); --prop-item lamp plans an appearance change.
prop_item = sys.argv[sys.argv.index('--prop-item') + 1] if '--prop-item' in sys.argv else 'lever'
class ObjectPlanner:
    configuration = character_planner.configuration
    configured = character_planner.configured

    def __call__(self, role, work, reference, **kwargs):
        planner = PropPlanner(prop_item) if work.spec.object_type == 'interactable' else character_planner
        return planner(role, work, reference, **kwargs)

service.open_motion_model = ObjectPlanner()
provider = Provider(fixture)
with ExitStack() as stack:
    stack.enter_context(patch('sprite_pipeline.providers.get_provider', return_value=provider))
    if '--expert-reviews' in sys.argv:
        from test_motion_adjustments import IntentRegistry as ExpertRegistry
        from sprite_pipeline.collaboration.checkpoints import Checkpoints
        from sprite_pipeline.collaboration.visual_review import QualityReviewer
        service.open_motion_review_registry=ExpertRegistry()
        service.adjustment_test_reviews=True
        stack.enter_context(patch.object(VisionReviewer,'_send',side_effect=AssertionError('Offline acceptance must never call an external model')))
        def simulated(original, segment):
            def invoke(self,job_id,index,*args):
                job=self.s.store.load(job_id);candidate=self.s._candidate(job,index)
                execution=candidate.plan_execution
                eligible=(execution.stages[args[0]].state=='complete' if segment else
                          bool(execution.quality_review and execution.quality_review.get('state')=='pending'))
                if not eligible:return original(self,job_id,index,*args)
                prior=candidate.diagnostic_only
                with self.s.store.locked_job(job_id) as current:self.s._candidate(current,index).diagnostic_only=False
                try:return original(self,job_id,index,*args)
                finally:
                    with self.s.store.locked_job(job_id) as current:
                        c=self.s._candidate(current,index);c.diagnostic_only=prior
                        report=c.plan_execution.stages[args[0]].review if segment else c.plan_execution.quality_review
                        if report and report.get('expert_review'):report['expert_review']['simulated']=True
            return invoke
        stack.enter_context(patch.object(Checkpoints,'inspect',simulated(Checkpoints.inspect,True)))
        stack.enter_context(patch.object(QualityReviewer,'run',simulated(QualityReviewer.run,False)))
    uvicorn.run(create_api(service=service), host='127.0.0.1', port=int(sys.argv[2]), log_level='warning')
