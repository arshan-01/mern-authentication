// import sgMail from '@sendgrid/mail';

// // Set the API key based on the environment
// sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// // Function to send email
// export const sendEmail = async ({to, subject, html, text}) => {
//   try {
//     const msg = {
//       from: `Translation By Native <${process.env.EMAIL}>`, // sender address
//       to: to, // recipient
//       subject: subject, // email subject
//       text,
//       html, // email body
//     };
//     // Send the email
//     await sgMail.send(msg);
//     console.log('Email sent successfully to:', to);
//   } catch (error) {
//     console.error('Error sending email:', error.response ? error.response.body : error.message);
//   }
// };

import nodemailer from 'nodemailer';

// Common function to send emails
export const sendEmail = async ({to, subject, html, text}) => {
  try {
    // create reusable transporter object using the default SMTP transport
    let transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true, // true for 465, false for other ports
      auth: {
        user: process.env.EMAIL, // your Gmail address
        pass: process.env.PASSWORD, // your Gmail password or app password
      },
    });

    // email options
    let mailOptions = {
        from: `"Blogs " <${process.env.EMAIL}>`, // sender address
        to: to, // recipient
        subject: subject, // email subject
        text,
        html, // email body
    };

    // Send the email
    await transporter.sendMail(mailOptions);
    // console.log(`Email sent`);
  } catch (error) {
    console.error('Error sending email:', error);
    throw error; // Propagate the error to handle it at the controller level
  }
};