'use client';
import { Textarea } from '@/components/ui/textarea';
import './motion-authoring-controls.css';

export function CharacterIdentityField({ value, onChange, maxLength, disabled = false }: { value: string; onChange: (value: string) => void; maxLength: number; disabled?: boolean }) {
  return <label className="character-identity-field">角色外观约束（可选）
    <Textarea aria-label="角色外观约束（可选）" value={value} onChange={(event) => onChange(event.target.value)} maxLength={maxLength} disabled={disabled}
      placeholder="例如：保持蓝黑色盔甲、头盔、长剑轮廓和青色发光线条；不要填写站姿或动作要求。" />
    <small>最多 {maxLength} 字符，只说明需保持的外观，与生图提示词及本次动作要求分别保存。留空沿用默认外观说明。</small>
  </label>;
}
