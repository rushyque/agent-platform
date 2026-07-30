BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[threads] (
    [id] NVARCHAR(128) NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [created_by] NVARCHAR(128),
    [title] NVARCHAR(500),
    [archived] BIT NOT NULL CONSTRAINT [threads_archived_df] DEFAULT 0,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [threads_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME2 NOT NULL,
    CONSTRAINT [threads_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[agent_events] (
    [id] BIGINT NOT NULL IDENTITY(1,1),
    [thread_id] NVARCHAR(128) NOT NULL,
    [run_id] NVARCHAR(128) NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [event_type] NVARCHAR(64) NOT NULL,
    [payload] NVARCHAR(1000) NOT NULL,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [agent_events_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [agent_events_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[agent_runs] (
    [id] BIGINT NOT NULL IDENTITY(1,1),
    [thread_id] NVARCHAR(128) NOT NULL,
    [run_id] NVARCHAR(128) NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [user_id] NVARCHAR(128),
    [steps] INT NOT NULL CONSTRAINT [agent_runs_steps_df] DEFAULT 0,
    [prompt_tokens] INT,
    [completion_tokens] INT,
    [duration_ms] INT,
    [finish_reason] NVARCHAR(32),
    [model] NVARCHAR(64),
    [intent] NVARCHAR(64),
    [status] NVARCHAR(20) NOT NULL,
    [created_at] DATETIME2 NOT NULL CONSTRAINT [agent_runs_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [agent_runs_pkey] PRIMARY KEY CLUSTERED ([id])
);

-- CreateTable
CREATE TABLE [dbo].[artifacts] (
    [ref] NVARCHAR(64) NOT NULL,
    [thread_id] NVARCHAR(128),
    [run_id] NVARCHAR(128),
    [tool_name] NVARCHAR(64) NOT NULL,
    [args] NVARCHAR(1000),
    [result] NVARCHAR(1000) NOT NULL,
    [summary] NVARCHAR(1000),
    [created_at] DATETIME2 NOT NULL CONSTRAINT [artifacts_created_at_df] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [artifacts_pkey] PRIMARY KEY CLUSTERED ([ref])
);

-- CreateTable
CREATE TABLE [dbo].[thread_summary] (
    [thread_id] NVARCHAR(128) NOT NULL,
    [summary] NVARCHAR(max) NOT NULL,
    [updated_at] DATETIME2 NOT NULL,
    CONSTRAINT [thread_summary_pkey] PRIMARY KEY CLUSTERED ([thread_id])
);

-- CreateIndex
CREATE NONCLUSTERED INDEX [threads_updated_at_idx] ON [dbo].[threads]([updated_at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [agent_events_thread_id_id_idx] ON [dbo].[agent_events]([thread_id], [id]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [agent_events_run_id_idx] ON [dbo].[agent_events]([run_id]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [agent_events_created_at_idx] ON [dbo].[agent_events]([created_at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [agent_runs_thread_id_created_at_idx] ON [dbo].[agent_runs]([thread_id], [created_at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [agent_runs_agent_id_created_at_idx] ON [dbo].[agent_runs]([agent_id], [created_at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [agent_runs_created_at_idx] ON [dbo].[agent_runs]([created_at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [agent_runs_status_idx] ON [dbo].[agent_runs]([status]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [artifacts_thread_id_created_at_idx] ON [dbo].[artifacts]([thread_id], [created_at]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [artifacts_run_id_idx] ON [dbo].[artifacts]([run_id]);

-- CreateIndex
CREATE NONCLUSTERED INDEX [artifacts_created_at_idx] ON [dbo].[artifacts]([created_at]);

-- AddForeignKey
ALTER TABLE [dbo].[agent_events] ADD CONSTRAINT [agent_events_thread_id_fkey] FOREIGN KEY ([thread_id]) REFERENCES [dbo].[threads]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[agent_runs] ADD CONSTRAINT [agent_runs_thread_id_fkey] FOREIGN KEY ([thread_id]) REFERENCES [dbo].[threads]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[artifacts] ADD CONSTRAINT [artifacts_thread_id_fkey] FOREIGN KEY ([thread_id]) REFERENCES [dbo].[threads]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE [dbo].[thread_summary] ADD CONSTRAINT [thread_summary_thread_id_fkey] FOREIGN KEY ([thread_id]) REFERENCES [dbo].[threads]([id]) ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
