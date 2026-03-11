import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { toast } from '@/hooks/use-toast';
import { ClipboardCopy, Link2, Link2Off, MessageCircle, X } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import {
  useTelegramStatusQuery,
  useGenerateTelegramLinkTokenMutation,
  useUnlinkTelegramMutation,
} from '@/hooks/Settings/useTelegramSettings';
import type { LinkTokenResult } from '@/hooks/Settings/useTelegramSettings';

export function TelegramSettings() {
  const { user } = useAuth();
  const [linkResult, setLinkResult] = useState<LinkTokenResult | null>(null);

  const { data: status, isLoading } = useTelegramStatusQuery(user?.id);

  const generateTokenMutation = useGenerateTelegramLinkTokenMutation();

  const unlinkMutation = useUnlinkTelegramMutation();

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: 'Copied!', description: `${label} copied to clipboard.` });
    });
  };

  return (
    <AccordionItem
      value="telegram-integration"
      className="border rounded-lg mb-4"
    >
      <AccordionTrigger
        className="flex items-center gap-2 p-4 hover:no-underline"
        description="Chat with Sparky directly from Telegram"
      >
        <MessageCircle className="h-5 w-5" />
        Telegram Integration
      </AccordionTrigger>
      <AccordionContent className="p-4 pt-0 space-y-4">
        <p className="text-sm text-muted-foreground">
          Link your Telegram account to chat with Sparky AI, log food,
          exercises, and measurements directly from the Telegram app — no
          browser needed.
        </p>

        {!isLoading && !status?.bot_configured && (
          <div className="p-3 bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded-md text-sm text-yellow-800 dark:text-yellow-200">
            ⚠️ The Telegram bot is not configured on this server. Ask your
            administrator to set{' '}
            <code className="font-mono">TELEGRAM_BOT_TOKEN</code> in the server
            environment variables.
          </div>
        )}

        {/* Current link status */}
        {!isLoading && status?.linked && (
          <div className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md">
            <div className="text-sm text-green-800 dark:text-green-200 space-y-0.5">
              <p className="font-medium">✅ Telegram account linked</p>
              {status.telegram_username && (
                <p className="text-xs">@{status.telegram_username}</p>
              )}
              {status.linked_at && (
                <p className="text-xs text-muted-foreground">
                  Since {new Date(status.linked_at).toLocaleDateString()}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                unlinkMutation.mutate(undefined, {
                  onSuccess: () => setLinkResult(null),
                  onError: () =>
                    toast({
                      title: 'Error',
                      description: 'Failed to unlink Telegram account.',
                      variant: 'destructive',
                    }),
                })
              }
              disabled={unlinkMutation.isPending}
              className="text-destructive border-destructive hover:bg-destructive hover:text-destructive-foreground"
            >
              <Link2Off className="h-4 w-4 mr-1" />
              {unlinkMutation.isPending ? 'Unlinking…' : 'Unlink'}
            </Button>
          </div>
        )}

        {/* Link token generation */}
        {(!status?.linked || linkResult) && (
          <div className="space-y-3">
            <Button
              onClick={() =>
                generateTokenMutation.mutate(undefined, {
                  onSuccess: (data) => setLinkResult(data),
                  onError: () =>
                    toast({
                      title: 'Error',
                      description: 'Failed to generate link token.',
                      variant: 'destructive',
                    }),
                })
              }
              disabled={
                generateTokenMutation.isPending ||
                isLoading ||
                !status?.bot_configured
              }
              className="w-full sm:w-auto"
            >
              <Link2 className="h-4 w-4 mr-2" />
              {generateTokenMutation.isPending
                ? 'Generating…'
                : 'Generate Link Token'}
            </Button>

            {linkResult && (
              <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md space-y-3">
                <div className="flex items-start justify-between">
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                    Your link token is ready!
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLinkResult(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <p className="text-xs text-blue-700 dark:text-blue-300">
                  This token expires at{' '}
                  <strong>
                    {new Date(linkResult.expires_at).toLocaleTimeString()}
                  </strong>{' '}
                  and can only be used once.
                </p>

                {linkResult.deep_link ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Click the link below to open Telegram and link your
                      account automatically:
                    </p>
                    <div className="flex items-center gap-2">
                      <a
                        href={linkResult.deep_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-xs font-mono truncate text-blue-600 dark:text-blue-400 underline"
                      >
                        {linkResult.deep_link}
                      </a>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          copyToClipboard(linkResult.deep_link!, 'Link')
                        }
                      >
                        <ClipboardCopy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Open Telegram, find your bot, and send this command:
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        readOnly
                        value={`/start ${linkResult.token}`}
                        className="font-mono text-xs bg-background"
                      />
                      <Button
                        size="sm"
                        onClick={() =>
                          copyToClipboard(
                            `/start ${linkResult.token}`,
                            'Link command'
                          )
                        }
                      >
                        <ClipboardCopy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
          <p className="font-medium">How it works</p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>Generate a link token above (valid for 15 minutes).</li>
            <li>Open Telegram and start a conversation with the bot.</li>
            <li>
              Send the /start command with the token (or click the deep link).
            </li>
            <li>
              Your account is linked — message Sparky to log food, exercise,
              water, and more!
            </li>
          </ol>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}
