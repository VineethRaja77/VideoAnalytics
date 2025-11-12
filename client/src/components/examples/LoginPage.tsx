import LoginPage from "../LoginPage";

export default function LoginPageExample() {
  return (
    <LoginPage
      onLogin={(username, password, remember) => {
        console.log("Login attempted:", { username, password, remember });
      }}
    />
  );
}
