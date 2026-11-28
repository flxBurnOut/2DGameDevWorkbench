import { SpriteStudioEntry } from '@/components/sprite-generator/open-motion-studio';
import { workbenchModules } from '@/lib/workbench/modules';

export default function SpriteGeneratorPage() {
  const spriteModule = workbenchModules.find(
    (candidate) => candidate.id === 'sprite-generator',
  );

  if (!spriteModule) return null;

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <SpriteStudioEntry module={spriteModule} />
    </div>
  );
}
