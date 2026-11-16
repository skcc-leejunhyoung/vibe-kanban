import { Bot, ArrowDown } from 'lucide-react';
import { Button } from '@vibe/ui/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/DropdownMenu';
import { Label } from '@vibe/ui/components/Label';
import type { ExecutorProfileId, BaseCodingAgent } from 'shared/types';

interface AgentSelectorProps {
  profiles: Record<string, Record<string, unknown>> | null;
  /**
   * Agents turned off on the host the profiles belong to. Passed by the
   * caller, which knows that host: read from the surrounding context it would
   * be the focused pane's host, not the one the dialog targets.
   */
  disabledExecutors: BaseCodingAgent[] | undefined;
  selectedExecutorProfile: ExecutorProfileId | null;
  onChange: (profile: ExecutorProfileId) => void;
  disabled?: boolean;
  className?: string;
  showLabel?: boolean;
}

export function AgentSelector({
  profiles,
  disabledExecutors,
  selectedExecutorProfile,
  onChange,
  disabled,
  className = '',
  showLabel = false,
}: AgentSelectorProps) {
  const selectedAgent = selectedExecutorProfile?.executor;
  const disabledAgents = disabledExecutors ?? [];
  const agents = profiles
    ? (Object.keys(profiles).sort() as BaseCodingAgent[]).filter(
        // Keep the currently selected agent visible even if disabled, so the
        // selection never breaks.
        (agent) => !disabledAgents.includes(agent) || agent === selectedAgent
      )
    : [];

  if (!profiles) return null;

  return (
    <div className="flex-1">
      {showLabel && (
        <Label htmlFor="executor-profile" className="text-sm font-medium">
          Agent
        </Label>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={`w-full justify-between text-xs ${showLabel ? 'mt-1.5' : ''} ${className}`}
            disabled={disabled}
            aria-label="Select agent"
          >
            <div className="flex items-center gap-1.5 w-full">
              <Bot className="h-3 w-3" />
              <span className="truncate">{selectedAgent || 'Agent'}</span>
            </div>
            <ArrowDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-60">
          {agents.length === 0 ? (
            <div className="p-2 text-sm text-muted-foreground text-center">
              No agents available
            </div>
          ) : (
            agents.map((agent) => (
              <DropdownMenuItem
                key={agent}
                onClick={() => {
                  onChange({
                    executor: agent,
                    variant: null,
                  });
                }}
                className={selectedAgent === agent ? 'bg-accent' : ''}
              >
                {agent}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
