// src/utils/invoiceGenerator.js
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

export const generateInvoicePDF = (booking) => {
  const doc = new jsPDF();

  // Colors
  const primaryColor = [255, 102, 0]; // Orange
  const textColor = [51, 51, 51];
  const lightGray = [245, 245, 245];

  // Page dimensions
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // =====================
  // HEADER
  // =====================

  // Company Logo/Name
  doc.setFillColor(...primaryColor);
  doc.rect(0, 0, pageWidth, 40, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(24);
  doc.setFont('helvetica', 'bold');
  doc.text('FOOTLOOSE ADVENTURES', pageWidth / 2, 20, { align: 'center' });

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Unforgettable Safari Experiences', pageWidth / 2, 30, {
    align: 'center',
  });

  // Invoice Title
  doc.setTextColor(...textColor);
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', 20, 55);

  // =====================
  // INVOICE INFO
  // =====================

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');

  // Left column - Company Info
  const leftCol = 20;
  let yPos = 70;

  doc.setFont('helvetica', 'bold');
  doc.text('From:', leftCol, yPos);
  yPos += 6;

  doc.setFont('helvetica', 'normal');
  doc.text('Footloose Adventures Ltd', leftCol, yPos);
  yPos += 5;
  doc.text('P.O. Box 12345', leftCol, yPos);
  yPos += 5;
  doc.text('Nairobi, Kenya', leftCol, yPos);
  yPos += 5;
  doc.text('Email: info@footlooseadventures.co.ke', leftCol, yPos);
  yPos += 5;
  doc.text('Phone: +254 700 000 000', leftCol, yPos);

  // Right column - Customer Info & Invoice Details
  const rightCol = pageWidth - 80;
  yPos = 70;

  doc.setFont('helvetica', 'bold');
  doc.text('Invoice Number:', rightCol, yPos);
  doc.setFont('helvetica', 'normal');
  doc.text(booking.booking_reference, rightCol + 35, yPos);
  yPos += 6;

  doc.setFont('helvetica', 'bold');
  doc.text('Date:', rightCol, yPos);
  doc.setFont('helvetica', 'normal');
  doc.text(
    new Date(booking.created_at).toLocaleDateString(),
    rightCol + 35,
    yPos
  );
  yPos += 6;

  doc.setFont('helvetica', 'bold');
  doc.text('Status:', rightCol, yPos);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...primaryColor);
  doc.text((booking.payment_status || 'pending').toUpperCase(), rightCol + 35, yPos);
  doc.setTextColor(...textColor);
  yPos += 10;

  // Bill To
  doc.setFont('helvetica', 'bold');
  doc.text('Bill To:', rightCol, yPos);
  yPos += 6;

  doc.setFont('helvetica', 'normal');
  doc.text(booking.customer_name, rightCol, yPos);
  yPos += 5;
  doc.text(booking.customer_email, rightCol, yPos);
  if (booking.customer_phone) {
    yPos += 5;
    doc.text(booking.customer_phone, rightCol, yPos);
  }

  // =====================
  // BOOKING DETAILS
  // =====================

  yPos = 125;

  doc.setFillColor(...lightGray);
  doc.rect(20, yPos, pageWidth - 40, 8, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Booking Details', 25, yPos + 5.5);

  yPos += 15;
  doc.setFontSize(10);

  // Tour Name
  doc.setFont('helvetica', 'bold');
  doc.text('Tour:', 25, yPos);
  doc.setFont('helvetica', 'normal');
  const tourTitle = doc.splitTextToSize(
    booking.tour?.title || 'Safari Tour',
    120
  );
  doc.text(tourTitle, 60, yPos);
  yPos += tourTitle.length * 5 + 5;

  // Dates
  doc.setFont('helvetica', 'bold');
  doc.text('Travel Dates:', 25, yPos);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `${new Date(booking.start_date).toLocaleDateString()} - ${new Date(
      booking.end_date
    ).toLocaleDateString()}`,
    60,
    yPos
  );
  yPos += 7;

  // Group Size - support both pax and group_size
  const groupSize = booking.pax ?? booking.group_size ?? 1;
  doc.setFont('helvetica', 'bold');
  doc.text('Group Size:', 25, yPos);
  doc.setFont('helvetica', 'normal');
  doc.text(`${groupSize} ${groupSize === 1 ? 'person' : 'people'}`, 60, yPos);
  yPos += 7;

  // Duration
  if (booking.tour?.duration) {
    doc.setFont('helvetica', 'bold');
    doc.text('Duration:', 25, yPos);
    doc.setFont('helvetica', 'normal');
    doc.text(
      `${booking.tour.duration} ${booking.tour.duration_unit || 'days'}`,
      60,
      yPos
    );
    yPos += 7;
  }

  // Special Requests
  if (booking.special_requests) {
    doc.setFont('helvetica', 'bold');
    doc.text('Special Requests:', 25, yPos);
    doc.setFont('helvetica', 'normal');
    const requests = doc.splitTextToSize(booking.special_requests, 120);
    doc.text(requests, 60, yPos);
    yPos += requests.length * 5 + 5;
  }

  // =====================
  // PRICING TABLE
  // =====================

  yPos += 10;

  // Calculate unit price
  const unitPrice = booking.price_per_person
    ? parseFloat(booking.price_per_person)
    : parseFloat(booking.total_price) / groupSize;

  // doc.autoTable({
  //   startY: yPos,
  //   head: [['Description', 'Quantity', 'Unit Price', 'Amount']],
  //   body: [
  //     [
  //       booking.tour?.title || 'Safari Tour',
  //       groupSize.toString(),
  //       `${booking.currency} ${unitPrice.toFixed(2)}`,
  //       `${booking.currency} ${parseFloat(booking.total_price).toFixed(2)}`,
  //     ],
  //   ],
  //   theme: 'striped',
  //   headStyles: {
  //     fillColor: primaryColor,
  //     fontSize: 10,
  //     fontStyle: 'bold',
  //   },
  //   styles: {
  //     fontSize: 10,
  //     cellPadding: 5,
  //   },
  //   columnStyles: {
  //     0: { cellWidth: 80 },
  //     1: { cellWidth: 30, halign: 'center' },
  //     2: { cellWidth: 40, halign: 'right' },
  //     3: { cellWidth: 40, halign: 'right' },
  //   },
  // });

  autoTable(doc, {
    startY: yPos,
    head: [['Description', 'Quantity', 'Unit Price', 'Amount']],
    body: [
      [
        booking.tour?.title || 'Safari Tour',
        groupSize.toString(),
        `${booking.currency} ${unitPrice.toFixed(2)}`,
        `${booking.currency} ${parseFloat(booking.total_price).toFixed(2)}`,
      ],
    ],
    theme: 'striped',
    headStyles: {
      fillColor: primaryColor,
      fontSize: 10,
      fontStyle: 'bold',
    },
    styles: {
      fontSize: 10,
      cellPadding: 5,
    },
    columnStyles: {
      0: { cellWidth: 80 },
      1: { cellWidth: 30, halign: 'center' },
      2: { cellWidth: 40, halign: 'right' },
      3: { cellWidth: 40, halign: 'right' },
    },
  });

  // =====================
  // TOTALS
  // =====================

  const finalY = doc.lastAutoTable?.finalY || yPos + 30;
  yPos = finalY + 10;

  // Subtotal
  doc.setFont('helvetica', 'normal');
  doc.text('Subtotal:', pageWidth - 80, yPos);
  doc.text(
    `${booking.currency} ${parseFloat(booking.total_price).toFixed(2)}`,
    pageWidth - 25,
    yPos,
    { align: 'right' }
  );
  yPos += 7;

  // Draw line
  doc.setLineWidth(0.5);
  doc.line(pageWidth - 80, yPos, pageWidth - 20, yPos);
  yPos += 7;

  // Total
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Total:', pageWidth - 80, yPos);
  doc.setTextColor(...primaryColor);
  doc.text(
    `${booking.currency} ${parseFloat(booking.total_price).toFixed(2)}`,
    pageWidth - 25,
    yPos,
    { align: 'right' }
  );
  doc.setTextColor(...textColor);

  // =====================
  // PAYMENT INFO
  // =====================

  yPos += 15;

  if (booking.payment_status === 'paid' && booking.payment_method) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(
      `Payment Method: ${
        booking.payment_method === 'mpesa' ? 'M-Pesa' : 'Card'
      }`,
      20,
      yPos
    );
    yPos += 5;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 128, 0);
    doc.text('✓ PAID', 20, yPos);
    doc.setTextColor(...textColor);
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 0, 0);
    doc.text('PAYMENT PENDING', 20, yPos);
    doc.setTextColor(...textColor);
  }

  // =====================
  // FOOTER
  // =====================

  const footerY = pageHeight - 30;

  doc.setFillColor(...lightGray);
  doc.rect(0, footerY - 5, pageWidth, 35, 'F');

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);

  doc.text(
    'Thank you for choosing Footloose Adventures!',
    pageWidth / 2,
    footerY + 2,
    { align: 'center' }
  );
  doc.text(
    'For inquiries, contact us at info@footlooseadventures.co.ke or +254 700 000 000',
    pageWidth / 2,
    footerY + 8,
    { align: 'center' }
  );
  doc.text('www.footlooseadventures.co.ke', pageWidth / 2, footerY + 14, {
    align: 'center',
  });

  // Return as buffer for email attachment
  return Buffer.from(doc.output('arraybuffer'));
};
