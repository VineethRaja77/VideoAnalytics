import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Eye, EyeOff } from "lucide-react";

interface LoginPageProps {
  onLogin: (username: string, password: string, remember: boolean) => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onLogin(username, password, remember);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md p-8">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center mb-4">
            <div className="text-primary text-3xl font-bold">
              HYPERSPARK
            </div>
          </div>
          <p className="text-muted-foreground text-sm">Video Management System</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="username" className="text-sm text-foreground">Email</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@company.com"
              className="h-11"
              data-testid="input-username"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-sm text-foreground">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="h-11 pr-10"
                data-testid="input-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                data-testid="button-toggle-password"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="remember"
                checked={remember}
                onCheckedChange={(checked) => setRemember(checked as boolean)}
                data-testid="checkbox-remember"
              />
              <Label htmlFor="remember" className="text-sm text-muted-foreground cursor-pointer">
                Keep me signed in
              </Label>
            </div>
            {/* This used to be a link that did nothing at all — clicked on the
                first screen every client sees, with no dialog, no message and
                no request. There is no self-service email reset in this
                product, so rather than fake one, it says what actually works:
                an organisation admin can reset any of their staff's passwords
                from Team Members. */}
            <button
              type="button"
              className="cursor-pointer text-sm text-primary hover:underline"
              aria-expanded={showHelp}
              onClick={() => setShowHelp((v) => !v)}
              data-testid="link-forgot-password"
            >
              Forgot Password?
            </button>
          </div>

          {showHelp && (
            <div
              role="status"
              className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground"
              data-testid="forgot-password-help"
            >
              Your organisation's administrator can set a new password for you
              from <strong>Team Members</strong> — ask them directly. If you are
              the administrator, contact your Hyperspark provider.
            </div>
          )}

          <Button
            type="submit"
            className="w-full h-11"
            data-testid="button-login"
          >
            Sign In
          </Button>
        </form>
      </div>
    </div>
  );
}
