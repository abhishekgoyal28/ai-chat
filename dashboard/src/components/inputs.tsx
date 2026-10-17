import { useEffect, useState } from 'react';

/**
 * A number input that lets the field be empty while typing. `nullable` maps
 * an empty field to null (meaning "provider default" in agent settings).
 */
export const NumberInput = ({
  value,
  onChange,
  min,
  max,
  step,
  nullable,
  placeholder,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  nullable?: boolean;
  placeholder?: string;
}) => {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [value]);
  return (
    <input
      type="number"
      value={text}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      onChange={(event) => {
        setText(event.target.value);
        if (event.target.value === '') {
          if (nullable) {
            onChange(null);
          }
          return;
        }
        const parsed = Number(event.target.value);
        if (!Number.isNaN(parsed)) {
          onChange(parsed);
        }
      }}
    />
  );
};

/** One entry per line, blank lines dropped. */
export const LinesInput = ({ value, onChange, rows = 4, placeholder }: { value: string[]; onChange: (value: string[]) => void; rows?: number; placeholder?: string }) => {
  const [text, setText] = useState(value.join('\n'));
  // Re-seed only when the value changes from outside, so typing a blank line is not undone.
  useEffect(() => {
    if (text.split('\n').map((line) => line.trim()).filter(Boolean).join('\n') !== value.join('\n')) {
      setText(value.join('\n'));
    }
  }, [value]);
  return (
    <textarea
      rows={rows}
      style={{ minHeight: 0 }}
      value={text}
      placeholder={placeholder}
      onChange={(event) => {
        setText(event.target.value);
        onChange(event.target.value.split('\n').map((line) => line.trim()).filter(Boolean));
      }}
    />
  );
};
