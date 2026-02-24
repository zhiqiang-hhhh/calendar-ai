# Calendar AI

Calendar AI is a Next.js application that leverages artificial intelligence to help you manage your schedule intelligently and efficiently. With Calendar AI, you can create and manage events using natural language, automatically reschedule events, and share your calendar with others.

## 🚀 Features

- **Create Events with Natural Language**: Schedule events simply by typing or speaking in natural language.
- **Complete Assistant with GPT Integration**: Use ChatGPT integration to receive intelligent suggestions and automate meeting and event scheduling.
- **Automatic Rescheduling**: AI-powered features to automatically adjust your calendar events when necessary (coming soon).
- **Calendar Sharing**: Share your calendar with anyone, making it easier to coordinate schedules and commitments (coming soon).

## 📦 Installation

Follow the steps below to set up the project locally.

1. **Clone the repository:**

   ```bash
   git clone https://github.com/typper-io/calendar-ai.git
   cd calendar-ai
   ```

2. **Install dependencies:**

   ```bash
   pnpm install
   ```

3. **Start the development server:**

   ```bash
   pnpm run dev
   ```

   The server will start at [http://localhost:3000](http://localhost:3000).

## 🛠️ Technologies Used

- **Next.js**: A React framework for building modern, high-performance web applications.
- **React**: A JavaScript library for building user interfaces.
- **OpenAI GPT**: Integration with OpenAI's GPT API for AI-powered assistance.
- **CSS Modules/TailwindCSS**: For styling the interface.

## 🔧 Environment Variables

To run this application, you need to configure several environment variables. You can do this by creating a `.env.local` file in the root directory of the project or by using the provided `.env.example` as a template.

### Required Environment Variables:

- `OPENAI_API_KEY`: API key for your OpenAI-compatible provider.
- `OPENAI_BASE_URL` (optional): Base URL of an OpenAI-compatible API endpoint. Leave empty for OpenAI default.
- `GOOGLE_CLIENT_ID`: The Client ID for Google OAuth, used for authenticating users.
- `GOOGLE_CLIENT_SECRET`: The Client Secret for Google OAuth.
- `NEXTAUTH_SECRET`: A secret key used by NextAuth.js to encrypt session data.
- `ASSISTANT_MODEL` (optional): Main model used for calendar assistant responses and tool-calling.
- `TIME_RANGE_MODEL` (optional): Model used to extract time ranges from user messages. Defaults to `ASSISTANT_MODEL`.
- `NEXTAUTH_URL`: The URL of your Next.js application, used by NextAuth.js.

### Steps to Generate and Use Environment Variables:

1. **Create a `.env.local` File:**
   Copy the `.env.example` file to a new file named `.env.local`:

   ```bash
   cp .env.example .env.local
   ```

2. **Add Your Credentials:**
   Open the `.env.local` file and fill in the values for each variable. You need to obtain these values from the respective service providers (OpenAI, Google, etc.).

3. **Run the Application:**
   After setting up the environment variables, you can start the development server:

   ```bash
   pnpm run dev
   ```

## 🤖 Cross-Provider Assistant Setup

This project now uses a provider-agnostic architecture based on `chat.completions + tool calling` (no Assistants API dependency). Tool definitions and instructions are loaded from:

- `assistant/functions/*.json`
- `assistant/instruction.txt`

Use any OpenAI-compatible provider by setting:

```bash
OPENAI_API_KEY=your-provider-key
OPENAI_BASE_URL=https://your-provider-openai-compatible-endpoint/v1
ASSISTANT_MODEL=your-model-name
TIME_RANGE_MODEL=your-time-range-model-name
```

Then run:

```bash
pnpm run dev
```

## 📄 License

This project is licensed under the [MIT License](./LICENSE).

## 🤝 Contributions

Contributions are welcome! Feel free to open issues or pull requests to suggest improvements or fix issues.

## 📧 Contact

For more information or support, contact [contact@typper.io](mailto:contact@typper.io).
