import { parseLiteLLMRequestTags } from "@t3tools/contracts";
import { TagIcon } from "lucide-react";
import { memo, useState } from "react";

import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

const sameTags = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((tag, index) => tag === right[index]);

/** LiteLLM request tags for the thread, edited as comma-separated text and committed on close. */
export const ComposerRequestTags = memo(function ComposerRequestTags(props: {
  value: string;
  size?: "sm" | "xs";
  onCommit: (text: string) => void;
}) {
  const size = props.size ?? "sm";
  const floatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(props.value);
  const count = parseLiteLLMRequestTags(props.value).length;
  const tooltip = count > 0 ? `LiteLLM tags: ${props.value}` : "Add LiteLLM tags";

  const commit = () => {
    const next = parseLiteLLMRequestTags(text);
    if (!sameTags(next, parseLiteLLMRequestTags(props.value))) props.onCommit(next.join(", "));
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setText(props.value);
        else commit();
        setOpen(nextOpen);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger render={<ComposerControl size={size} aria-label="LiteLLM tags" />} />
          }
        >
          <ComposerControlIcon icon={TagIcon} size={size} />
          <span data-composer-control-label className={count > 0 ? "tabular-nums" : "sr-only"}>
            {count > 0 ? count : "Tags"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" side="top" width="sm" padding="compact" {...floatingLayerProps}>
        <div className="flex flex-col gap-1.5">
          <Input
            size="compact"
            aria-label="LiteLLM tags"
            placeholder="Tags, separated by commas"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commit();
              setOpen(false);
            }}
          />
          <p className="text-muted-foreground text-xs">
            Sent to LiteLLM as project:tag, in place of project:general-admin.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
