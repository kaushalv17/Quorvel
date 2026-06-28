import { SignIn } from "@clerk/nextjs"

const wrap = { display: "flex", justifyContent: "center", padding: "64px 16px" }

export default function SignInPage() {
	return (
		<div style={wrap}>
			<SignIn />
		</div>
	)
}
