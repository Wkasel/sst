import { Construct } from "constructs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { App } from "./App.js";
import { getFunctionRef, SSTConstruct, isCDKConstruct } from "./Construct.js";
import {
  Function as Fn,
  FunctionInlineDefinition,
  FunctionDefinition,
} from "./Function.js";
import { toCdkDuration } from "./util/duration.js";
import { Permissions } from "./util/permission.js";

/**
 * Used to define the consumer for the queue and invocation details
 */
export interface QueueConsumerProps {
  /**
   * Used to create the consumer function for the queue.
   *
   * @example
   * ```js
   * new Queue(stack, "Queue", {
   *   consumer: {
   *     function: {
   *       handler: "src/function.handler",
   *       timeout: 10,
   *     },
   *   },
   * });
   * ```
   */
  function?: FunctionDefinition;
  cdk?: {
    /**
     * This allows you to use an existing or imported Lambda function.
     *
     * @example
     * ```js
     * new Queue(stack, "Queue", {
     *   consumer: {
     *     cdk: {
     *       function: lambda.Function.fromFunctionAttributes(stack, "ImportedFn", {
     *         functionArn: "arn:aws:lambda:us-east-1:123456789:function:my-function",
     *         role: iam.Role.fromRoleArn(stack, "IRole", "arn:aws:iam::123456789:role/my-role"),
     *       }),
     *     },
     *   },
     * });
     * ```
     */
    function?: lambda.IFunction;
    /**
     * This allows you to override the default settings this construct uses internally to create the consumer.
     *
     * @example
     * ```js
     * new Queue(stack, "Queue", {
     *   consumer: {
     *     function: "test/lambda.handler",
     *     cdk: {
     *       eventSource: {
     *         batchSize: 5,
     *       },
     *     },
     *   },
     * });
     * ```
     */
    eventSource?: lambdaEventSources.SqsEventSourceProps;
  };
}

export interface QueueProps {
  /**
   * Used to create the consumer for the queue.
   *
   * @example
   * ```js
   * new Queue(stack, "Queue", {
   *   consumer: "src/function.handler",
   * })
   * ```
   */
  consumer?: FunctionInlineDefinition | QueueConsumerProps;
  cdk?: {
    /**
     * Allows you to override default id for this construct.
     */
    id?: string;
    /**
     * Override the default settings this construct uses internally to create the queue.
     *
     * @example
     * ```js
     * new Queue(stack, "Queue", {
     *   consumer: "src/function.handler",
     *   cdk: {
     *     queue: {
     *       fifo: true,
     *     },
     *   }
     * });
     * ```
     */
    queue?: sqs.IQueue | sqs.QueueProps;
  };
}

/////////////////////
// Construct
/////////////////////

/**
 * The `Queue` construct is a higher level CDK construct that makes it easy to create an SQS Queue and configure a consumer function.
 *
 * @example
 *
 * ```js
 * import { Queue } from "@serverless-stack/resources";
 *
 * new Queue(stack, "Queue", {
 *   consumer: "src/queueConsumer.main",
 * });
 * ```
 */
export class Queue extends Construct implements SSTConstruct {
  public readonly id: string;
  public readonly cdk: {
    /**
     * The internally created CDK `Queue` instance.
     */
    queue: sqs.IQueue;
  };
  /**
   * The internally created consumer `Function` instance.
   */
  public consumerFunction?: Fn | lambda.IFunction;
  private bindingForAllConsumers: SSTConstruct[] = [];
  private permissionsAttachedForAllConsumers: Permissions[] = [];
  private props: QueueProps;

  constructor(scope: Construct, id: string, props?: QueueProps) {
    super(scope, props?.cdk?.id || id);

    this.id = id;
    this.props = props || {};
    this.cdk = {} as any;

    this.createQueue();

    if (props?.consumer) {
      this.addConsumer(this, props.consumer);
    }
  }

  /**
   * The ARN of the SQS Queue
   */
  public get queueArn(): string {
    return this.cdk.queue.queueArn;
  }

  /**
   * The URL of the SQS Queue
   */
  public get queueUrl(): string {
    return this.cdk.queue.queueUrl;
  }

  /**
   * The name of the SQS Queue
   */
  public get queueName(): string {
    return this.cdk.queue.queueName;
  }

  /**
   * Adds a consumer after creating the queue. Note only one consumer can be added to a queue
   *
   * @example
   * ```js {3}
   * const queue = new Queue(stack, "Queue");
   * queue.addConsumer(props.stack, "src/function.handler");
   * ```
   */
  public addConsumer(
    scope: Construct,
    consumer: FunctionInlineDefinition | QueueConsumerProps
  ): void {
    if (this.consumerFunction) {
      throw new Error("Cannot configure more than 1 consumer for a Queue");
    }

    if ((consumer as QueueConsumerProps).cdk?.function) {
      consumer = consumer as QueueConsumerProps;
      this.addCdkFunctionConsumer(scope, consumer);
    } else {
      consumer = consumer as FunctionInlineDefinition | QueueConsumerProps;
      this.addFunctionConsumer(scope, consumer);
    }
  }

  private addCdkFunctionConsumer(
    scope: Construct,
    consumer: QueueConsumerProps
  ): void {
    // Parse target props
    const eventSourceProps = consumer.cdk?.eventSource;
    const fn = consumer.cdk!.function!;

    // Create target
    fn.addEventSource(
      new lambdaEventSources.SqsEventSource(this.cdk.queue, eventSourceProps)
    );

    this.consumerFunction = fn;
  }

  private addFunctionConsumer(
    scope: Construct,
    consumer: FunctionInlineDefinition | QueueConsumerProps
  ): void {
    // Parse consumer props
    let eventSourceProps;
    let functionDefinition;
    if ((consumer as QueueConsumerProps).function) {
      consumer = consumer as QueueConsumerProps;
      eventSourceProps = consumer.cdk?.eventSource;
      functionDefinition = consumer.function!;
    } else {
      consumer = consumer as FunctionInlineDefinition;
      functionDefinition = consumer;
    }

    // Create function
    const fn = Fn.fromDefinition(
      scope,
      `Consumer_${this.node.id}`,
      functionDefinition
    );
    fn.addEventSource(
      new lambdaEventSources.SqsEventSource(this.cdk.queue, eventSourceProps)
    );

    // Attach permissions
    this.permissionsAttachedForAllConsumers.forEach((permissions) => {
      fn.attachPermissions(permissions);
    });
    fn.bind(this.bindingForAllConsumers);

    this.consumerFunction = fn;
  }

  /**
   * Binds the given list of resources to the consumer function
   *
   * @example
   * ```js
   * const queue = new Queue(stack, "Queue", {
   *   consumer: "src/function.handler",
   * });
   * queue.bind([STRIPE_KEY, bucket]);
   * ```
   */
  public bind(constructs: SSTConstruct[]): void {
    if (this.consumerFunction instanceof Fn) {
      this.consumerFunction.bind(constructs);
    }

    this.bindingForAllConsumers.push(...constructs);
  }

  /**
   * Attaches additional permissions to the consumer function
   *
   * @example
   * ```js
   * const queue = new Queue(stack, "Queue", {
   *   consumer: "src/function.handler",
   * });
   * queue.attachPermissions(["s3"]);
   * ```
   */
  public attachPermissions(permissions: Permissions): void {
    if (this.consumerFunction instanceof Fn) {
      this.consumerFunction.attachPermissions(permissions);
    }

    this.permissionsAttachedForAllConsumers.push(permissions);
  }

  public getConstructMetadata() {
    return {
      type: "Queue" as const,
      data: {
        name: this.cdk.queue.queueName,
        url: this.cdk.queue.queueUrl,
        consumer: getFunctionRef(this.consumerFunction),
      },
    };
  }

  /** @internal */
  public getFunctionBinding() {
    return {
      clientPackage: "queue",
      variables: {
        queueUrl: {
          environment: this.queueUrl,
          parameter: this.queueUrl,
        },
      },
      permissions: {
        "sqs:*": [this.queueArn],
      },
    };
  }

  private createQueue() {
    const { cdk } = this.props;
    const root = this.node.root as App;
    const id = this.node.id;

    if (isCDKConstruct(cdk?.queue)) {
      this.cdk.queue = cdk?.queue as sqs.Queue;
    } else {
      const sqsQueueProps: sqs.QueueProps = cdk?.queue || {};

      // If debugIncreaseTimeout is enabled (ie. sst start):
      // - Set visibilityTimeout to > 900s. This is because Lambda timeout is
      //   set to 900s, and visibilityTimeout has to be greater or equal to it.
      //   This will give people more time to debug the function without timing
      //   out the request.
      let debugOverrideProps;
      if (root.debugIncreaseTimeout) {
        if (
          !sqsQueueProps.visibilityTimeout ||
          sqsQueueProps.visibilityTimeout.toSeconds() < 900
        ) {
          // TODO
          console.log(toCdkDuration("900 seconds"));
          debugOverrideProps = {
            visibilityTimeout: toCdkDuration("900 seconds"),
          };
        }
      }

      const name =
        root.logicalPrefixedName(id) + (sqsQueueProps.fifo ? ".fifo" : "");
      this.cdk.queue = new sqs.Queue(this, "Queue", {
        queueName: name,
        ...sqsQueueProps,
        ...debugOverrideProps,
      });
    }
  }
}
