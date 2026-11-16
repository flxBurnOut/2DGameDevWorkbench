/* oxlint-disable next/no-img-element -- The small local SVG is shared with the favicon. */
import { workbenchBrand } from '@/lib/workbench/brand';

export function WorkbenchBrand() {
  return (
    <>
      <WorkbenchBrandIcon />
      <span>
        <strong>{workbenchBrand.name}</strong>
      </span>
    </>
  );
}

export function WorkbenchBrandIcon({ size = 40, className = 'wb-brandmark' }: { size?: number; className?: string }) {
  return <img className={className} src={workbenchBrand.icon} width={size} height={size} alt="" aria-hidden="true" />;
}
