import { useEffect, useState } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { Input } from '@vibe/ui/components/Input';
import { Label } from '@vibe/ui/components/Label';
import { defineModal } from '@/shared/lib/modals';
import {
  bookmarkUserKey,
  normalizeBookmarkUrl,
  useUrlBookmarksStore,
} from '@/shared/stores/useUrlBookmarksStore';

type BookmarkDialogProps = { userId: string | null };

const AddUrlBookmarkDialogImpl = create<BookmarkDialogProps>(({ userId }) => {
  const modal = useModal();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const bookmarks = useUrlBookmarksStore(
    (state) => state.bookmarksByUser[bookmarkUserKey(userId)] ?? []
  );

  useEffect(() => {
    if (!modal.visible) return;
    setName('');
    setUrl('');
  }, [modal.visible]);

  const normalizedUrl = normalizeBookmarkUrl(url);
  const duplicate = bookmarks.some(
    (bookmark) => bookmark.url === normalizedUrl
  );
  const canAdd = name.trim().length > 0 && normalizedUrl !== null && !duplicate;
  const close = () => {
    modal.resolve();
    modal.hide();
  };

  return (
    <Dialog open={modal.visible} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canAdd) return;
            useUrlBookmarksStore.getState().addBookmark(userId, url, name);
            close();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add bookmark</DialogTitle>
            <DialogDescription>
              Enter the name and address shown in the command palette.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="bookmark-name">Name</Label>
              <Input
                id="bookmark-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bookmark-url">Address</Label>
              <Input
                id="bookmark-url"
                placeholder="https://example.com"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              {url && !normalizedUrl && (
                <p className="text-sm text-error">Enter a valid HTTP(S) URL.</p>
              )}
              {duplicate && (
                <p className="text-sm text-error">
                  This address is already bookmarked.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canAdd}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
});

const RemoveUrlBookmarkDialogImpl = create<BookmarkDialogProps>(
  ({ userId }) => {
    const modal = useModal();
    const bookmarks = useUrlBookmarksStore(
      (state) => state.bookmarksByUser[bookmarkUserKey(userId)] ?? []
    );
    const close = () => {
      modal.resolve();
      modal.hide();
    };

    return (
      <Dialog open={modal.visible} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove bookmark</DialogTitle>
            <DialogDescription>
              Select the bookmark you want to remove.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto py-4">
            {bookmarks.length === 0 ? (
              <p className="text-sm text-low">No bookmarks saved.</p>
            ) : (
              bookmarks.map((bookmark) => (
                <Button
                  key={bookmark.url}
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-start text-left"
                  onClick={async () => {
                    const result = await ConfirmDialog.show({
                      title: 'Remove bookmark?',
                      message: `${bookmark.name}\n${bookmark.url}`,
                      confirmText: 'Remove',
                      variant: 'destructive',
                    });
                    if (result !== 'confirmed') return;
                    useUrlBookmarksStore
                      .getState()
                      .removeBookmark(userId, bookmark.url);
                    close();
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {bookmark.name}
                    </span>
                    <span className="block truncate text-xs text-low">
                      {bookmark.url}
                    </span>
                  </span>
                </Button>
              ))
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const AddUrlBookmarkDialog = defineModal<BookmarkDialogProps, void>(
  AddUrlBookmarkDialogImpl
);
export const RemoveUrlBookmarkDialog = defineModal<BookmarkDialogProps, void>(
  RemoveUrlBookmarkDialogImpl
);
