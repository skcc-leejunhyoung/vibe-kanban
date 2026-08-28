import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { VirtuosoHandle } from 'react-virtuoso';
import type { Tag } from 'shared/remote-types';
import {
  SearchableTagDropdown,
  TAG_COLORS,
} from '@vibe/ui/components/SearchableTagDropdown';
import { fuzzySearchMatch } from '@vibe/ui/lib/search';
import { pickUnusedColor } from '@/shared/lib/colors';

interface SearchableTagDropdownContainerProps {
  tags: Tag[];
  selectedTagIds: string[];
  onTagToggle: (tagId: string) => void;
  onCreateTag: (data: { name: string; color: string }) => string;
  trigger: React.ReactNode;
  disabled: boolean;
  contentClassName: string;
}

export function SearchableTagDropdownContainer({
  tags,
  selectedTagIds,
  onTagToggle,
  onCreateTag,
  trigger,
  disabled,
  contentClassName,
}: SearchableTagDropdownContainerProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newTagColor, setNewTagColor] = useState<string>(TAG_COLORS[0]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  // Auto-focus color picker when entering create mode
  useEffect(() => {
    if (isCreating && colorPickerRef.current) {
      colorPickerRef.current.focus();
    }
  }, [isCreating]);

  // Enter create mode with a color that doesn't collide with existing tags
  const startCreate = useCallback(() => {
    setNewTagColor(pickUnusedColor(tags.map((t) => t.color)));
    setIsCreating(true);
  }, [tags]);

  // Filter tags based on search term
  const filteredTags = useMemo(() => {
    if (!searchTerm.trim()) return tags;
    return tags.filter((tag) => fuzzySearchMatch(tag.name, searchTerm));
  }, [tags, searchTerm]);

  // Check if search term matches any existing tag exactly
  const hasExactMatch = useMemo(() => {
    if (!searchTerm.trim()) return true; // Don't show create when empty
    const query = searchTerm.toLowerCase().trim();
    return tags.some((tag) => tag.name.toLowerCase() === query);
  }, [tags, searchTerm]);

  // Show create option when there's a search term and no exact match
  const showCreateOption = searchTerm.trim().length > 0 && !hasExactMatch;

  // Safe highlight index
  const safeHighlightedIndex = useMemo(() => {
    if (highlightedIndex === null) return null;
    if (highlightedIndex >= filteredTags.length) return null;
    return highlightedIndex;
  }, [highlightedIndex, filteredTags.length]);

  // Highlight create option when no tag is highlighted and create is available
  const createOptionHighlighted =
    safeHighlightedIndex === null && showCreateOption;

  const handleSearchTermChange = useCallback((value: string) => {
    setSearchTerm(value);
    setHighlightedIndex(null);
    setIsCreating(false);
  }, []);

  const moveHighlight = useCallback(
    (delta: 1 | -1) => {
      if (filteredTags.length === 0) return;
      const start = safeHighlightedIndex ?? -1;
      const next = (start + delta + filteredTags.length) % filteredTags.length;
      setHighlightedIndex(next);
      virtuosoRef.current?.scrollIntoView({ index: next, behavior: 'auto' });
    },
    [filteredTags, safeHighlightedIndex]
  );

  const attemptToggle = useCallback(() => {
    if (safeHighlightedIndex == null) return;
    const tag = filteredTags[safeHighlightedIndex];
    if (!tag) return;
    onTagToggle(tag.id);
  }, [safeHighlightedIndex, filteredTags, onTagToggle]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isCreating) {
        // Color picker mode keyboard navigation
        switch (e.key) {
          case 'ArrowLeft': {
            e.preventDefault();
            e.stopPropagation();
            const idx = (TAG_COLORS as readonly string[]).indexOf(newTagColor);
            setNewTagColor(
              TAG_COLORS[idx <= 0 ? TAG_COLORS.length - 1 : idx - 1]
            );
            return;
          }
          case 'ArrowRight': {
            e.preventDefault();
            e.stopPropagation();
            const idx = (TAG_COLORS as readonly string[]).indexOf(newTagColor);
            setNewTagColor(TAG_COLORS[(idx + 1) % TAG_COLORS.length]);
            return;
          }
          case 'Enter':
            e.preventDefault();
            e.stopPropagation();
            if (searchTerm.trim()) {
              const newTagId = onCreateTag({
                name: searchTerm.trim(),
                color: newTagColor,
              });
              onTagToggle(newTagId); // Auto-select the newly created tag
              setSearchTerm('');
              setIsCreating(false);
            }
            return;
          case 'Escape':
            e.preventDefault();
            e.stopPropagation();
            setIsCreating(false);
            return;
          default:
            e.stopPropagation();
            return;
        }
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          moveHighlight(1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          moveHighlight(-1);
          return;
        case 'Enter':
          e.preventDefault();
          e.stopPropagation();
          if (safeHighlightedIndex !== null) {
            attemptToggle();
          } else if (showCreateOption) {
            startCreate();
          }
          return;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          setDropdownOpen(false);
          return;
        case 'Tab':
          return;
        default:
          e.stopPropagation();
      }
    },
    [
      isCreating,
      moveHighlight,
      safeHighlightedIndex,
      attemptToggle,
      showCreateOption,
      startCreate,
      searchTerm,
      newTagColor,
      onCreateTag,
      onTagToggle,
    ]
  );

  const handleOpenChange = useCallback((next: boolean) => {
    setDropdownOpen(next);
    if (!next) {
      setSearchTerm('');
      setHighlightedIndex(null);
      setIsCreating(false);
    }
  }, []);

  const handleConfirmCreate = useCallback(() => {
    if (!searchTerm.trim()) return;
    const newTagId = onCreateTag({
      name: searchTerm.trim(),
      color: newTagColor,
    });
    onTagToggle(newTagId); // Auto-select the newly created tag
    setSearchTerm('');
    setIsCreating(false);
  }, [searchTerm, newTagColor, onCreateTag, onTagToggle]);

  const handleCancelCreate = useCallback(() => {
    setIsCreating(false);
  }, []);

  return (
    <SearchableTagDropdown
      filteredTags={filteredTags}
      selectedTagIds={selectedTagIds}
      onTagToggle={onTagToggle}
      trigger={trigger}
      searchTerm={searchTerm}
      onSearchTermChange={handleSearchTermChange}
      highlightedIndex={safeHighlightedIndex}
      onHighlightedIndexChange={setHighlightedIndex}
      open={dropdownOpen}
      onOpenChange={handleOpenChange}
      onKeyDown={handleKeyDown}
      virtuosoRef={virtuosoRef}
      showCreateOption={showCreateOption}
      createOptionHighlighted={createOptionHighlighted}
      isCreating={isCreating}
      newTagColor={newTagColor}
      onNewTagColorChange={setNewTagColor}
      onStartCreate={startCreate}
      onConfirmCreate={handleConfirmCreate}
      onCancelCreate={handleCancelCreate}
      colorPickerRef={colorPickerRef}
      contentClassName={contentClassName}
      disabled={disabled}
    />
  );
}
